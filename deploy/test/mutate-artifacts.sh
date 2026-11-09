#!/usr/bin/env bash
# Mutation check of the artifact hand-over tests (spec 005, 3.6): break one protective step at a time in the server's
# copy of the sources and require that the Go tests fail. Run on the dev server, in the working copy to test. The sources
# are restored after every mutation and at exit. A mutation whose text is not found makes the run fail.
set -uo pipefail
S=${SRC:-$(cd "$(dirname "$0")/../.." && pwd)}
export PATH=$S/runtime/go/bin:$PATH
fails=0 total=0
backup=$(mktemp)
current=""
trap '[[ -n $current ]] && cp "$backup" "$S/$current"; rm -f "$backup"' EXIT

skipped=0
mut() { # file  sed-expression  directory  go-test-regex  label  [root]
  local file=$1 expr=$2 dir=$3 re=$4 label=$5 needs=${6:-}
  if [[ $needs == root && $EUID -ne 0 ]]; then
    echo "SKIPPED (its tests need root; run this as root on the server): $label"; skipped=$((skipped + 1)); return
  fi
  total=$((total + 1))
  # a mutation that lets the job's processes live leaves some of the test user's behind, and the next test of that kind
  # then SKIPS (the uid is not free) and passes: clear them before and after every mutation
  [[ $EUID -eq 0 ]] && pkill -9 -u 64999 2>/dev/null
  current=$file
  cp "$S/$file" "$backup"
  sed -i "$expr" "$S/$file"
  if cmp -s "$S/$file" "$backup"; then
    echo "NOT APPLIED: $label"; fails=$((fails + 1))
  elif (cd "$S/$dir" && go test -count=1 -run "$re" ./... >/tmp/zs-mut.log 2>&1); then
    echo "SURVIVED:    $label"; fails=$((fails + 1))
  elif grep -q -- '--- FAIL' /tmp/zs-mut.log; then
    echo "caught:      $label"
  else
    echo "BROKEN BUILD (not a catch): $label"; fails=$((fails + 1))
  fi
  cp "$backup" "$S/$file"
  current=""
  [[ $EUID -eq 0 ]] && pkill -9 -u 64999 2>/dev/null
  return 0
}

mut supervisor/artifacts.go 's/if sum\[:16\] != m\[1\] {/if false {/' supervisor 'TestArtifact|TestPng|TestBinary' "hash check off"
mut supervisor/artifacts.go 's/if m\[2\] == "png" \&\& /if false \&\& /' supervisor 'TestPng' "png magic check off"
mut supervisor/run.go 's/^\tr.fetches.Wait().*/\t\/\/ removed/' supervisor 'TestFetchesFinish|TestArtifactIsFetched' "no wait for fetches before stopping the VM"
mut supervisor/run.go 's/r.artSeen\[name\] || b == nil/b == nil/' supervisor 'TestAnnouncedTwice' "dedupe off"
mut supervisor/run.go 's/r.artFiles >= s.cfg.MaxArtifacts || //' supervisor 'TestArtifactCountLimit' "count limit off"
mut supervisor/run.go 's/r.artBytes+need > s.cfg.MaxArtifactBytes/false/' supervisor 'TestArtifactTotalSize' "size limit off"
mut supervisor/run.go 's/!artifactNameRe.MatchString(name) || //' supervisor 'TestAnnouncementsThat' "name check off in the announcement"
mut supervisor/api.go 's/w.Header().Set("X-Content-Type-Options", "nosniff")//' supervisor 'TestArtifactIsServedWithSafeHeaders' "nosniff removed"
mut supervisor/vsock.go 's/if h.Bytes < 0 || h.Bytes > max {/if false {/' supervisor 'TestFetchOverTheWire' "size cap in fetch off"
mut guest/agent/artifact.go 's/syscall.O_NOFOLLOW|//' guest/agent 'TestArtifactRefusals' "O_NOFOLLOW off"
mut guest/agent/artifact.go 's/!st.Mode().IsRegular()/false/' guest/agent 'TestArtifactRefusals' "regular-file check off"
mut guest/agent/artifact.go 's/ok \&\& a.cred != nil \&\& sys.Uid != a.cred.Uid/ok \&\& false \&\& sys.Uid != 0/' guest/agent 'TestArtifactOfAnotherOwner' "owner check off"
mut guest/agent/artifact.go 's/if st.Size() > a.cfg.MaxArtifact {/if false {/' guest/agent 'TestArtifactRefusals' "size cap off"

# ---- the rest of the supervisor's protective steps (added 9 Nov 2026): approval, command risk and size, slots, limits ----
mut supervisor/session.go 's/if !SameDigest(sha256, e.sha256) {/if false {/' supervisor 'TestSession_ApprovalBoundToItsOwnCommand|TestSessions_RiskyCommandHeldUntilApprovalWithItsHash|TestAPISessions_ApprovalWithTheHashOfAnotherCommandIsRefused' "approval accepted with any hash"
mut supervisor/session.go 's/if e.expiresAt != 0 \&\& s.o.Now() >= e.expiresAt {/if false {/' supervisor 'TestSession_ExpiryEnforcedAtApprovalTimeWhenTimerHasNotFired|TestAPISessions_ApprovalThatCameTooLateGets410' "a late approval is still accepted"
mut supervisor/session.go 's/if e.status != CmdAwaitingApproval {/if false {/' supervisor 'TestSession_ApprovalIsOneTime|TestSession_ApproveUnknownIsNotFoundSafeIsNotWaiting' "approving a command that is not waiting"
mut supervisor/commands.go 's/"download":    {risk: RiskRisky,/"download":    {risk: RiskSafe,/' supervisor 'TestCommands_EveryTypeAcceptedRiskFollowsType|TestCommands_OnlyDownloadAndSubmitFormAreRisky' "download no longer risky"
mut supervisor/commands.go 's/"submit_form": {risk: RiskRisky,/"submit_form": {risk: RiskSafe,/' supervisor 'TestCommands_EveryTypeAcceptedRiskFollowsType|TestCommands_OnlyDownloadAndSubmitFormAreRisky' "submit_form no longer risky"
mut supervisor/commands.go 's/if len(canonical) > maxCommandBytes {/if false {/' supervisor 'TestCommands_LongerThan4KiBRejected|TestCommands_SizeLimitIsExactly4096Bytes' "command size limit off"
mut supervisor/commands.go 's/return ValidCommand{}, "unknown field: " + k/_ = k/' supervisor 'TestCommands_UnknownMissingMisplacedFieldsRejected' "unknown command field accepted"
mut supervisor/run.go 's/s.quarantined\[r.slot\] = r.vm/_ = r.vm/' supervisor 'TestCore_AVMThatDoesNotEndKeepsItsSlot' "a VM that did not end gives its slot away"
mut supervisor/supervisor.go 's/OK: len(s.quarantined) < s.cfg.Concurrency,/OK: true,/' supervisor 'TestCore_AVMThatDoesNotEndKeepsItsSlot' "health says ok with every slot held"
mut supervisor/supervisor.go 's/return rec.Session == nil || s.sessionRuns < s.cfg.SessionSlots/return true/' supervisor 'TestSessions_SlotsSecondSessionWaitsPlainRunsPassItStartsWhenFirstEnds' "session slot limit off"
mut supervisor/supervisor.go 's/if session != nil \&\& s.cfg.SessionSlots == 0 {/if false {/' supervisor 'TestSessions_SwitchedOffRequestIsRefusedInsteadOfWaitingForever|TestAPISessions_RefusedWith503WhenSessionsAreSwitchedOff' "sessions switched off but still accepted"
mut supervisor/api.go 's/if parsed.Scheme != "http" \&\& parsed.Scheme != "https" {/if false {/' supervisor 'TestAPI_ValidateSubmit_AcceptsHTTPAndRejectsEverythingElse' "any URL scheme accepted"
mut supervisor/store.go 's/func validRunID(id string) bool { return runIDRe.MatchString(id) }/func validRunID(id string) bool { return true }/' supervisor 'TestStore_InvalidRunIDsAreRejected|TestStore_DeleteWithPathTraversalIDTouchesNothingOutside|TestCore_RunIDsAreValidatedBeforeTheyReachAPath' "run id check off (path traversal)"
mut supervisor/vsock.go 's/if len(line) > maxLine {/if false {/' supervisor 'TestHost_RunAgentJob_OverLongLineIsAnError' "guest line length cap off"
mut supervisor/api.go 's/if len(b) > maxBody {/if false {/' supervisor 'TestAPI_BodyLimitBoundary' "request body limit off"
mut supervisor/run.go 's/r.hard = time.AfterFunc(hardFor,/r.hard = time.AfterFunc(hardFor+24*365*time.Hour,/' supervisor 'TestCore_HardTimeoutDestroysHungVM|TestSessions_SupervisorCeilingEndsSessionThatIgnoresCloseAndTimeLimit' "no hard timeout"

# ---- the guest agent's other protective steps (added 9 Nov 2026): process groups, killing, caps, deadlines, environment ----
mut guest/agent/agent.go 's/Setpgid: true, Credential: a.cred/Setpgid: false, Credential: a.cred/' guest/agent 'TestTimeoutKillsWholeProcessGroup|TestClientGoneKillsJob' "the job has no process group of its own"
# the group is killed twice, on cancel and again after the wait (the second catches stragglers): one alone changes nothing
mut guest/agent/agent.go 's/syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)/syscall.Kill(cmd.Process.Pid, syscall.SIGKILL)/;s/_ = syscall.Kill(-pgid, syscall.SIGKILL) \/\/ stragglers in the same process group/_ = pgid/' guest/agent 'TestTimeoutKillsWholeProcessGroup|TestClientGoneKillsJob' "nothing kills the job's other processes in its group"
mut guest/agent/agent.go 's/a.killJobUser()  *\/\/ and any that left it/_ = 0/' guest/agent 'TestEveryProcessOfTheJobUserIsKilled|TestTimeoutHoldsWhenAProcessLeavesTheGroupAndKeepsTheOutput' "processes that left the group (setsid) survive" root
mut guest/agent/proc.go 's/_ = syscall.Kill(pid, syscall.SIGKILL)/_ = syscall.Kill(pid, 0)/' guest/agent 'TestEveryProcessOfTheJobUserIsKilled|TestTimeoutHoldsWhenAProcessLeavesTheGroupAndKeepsTheOutput' "killUser kills nobody" root
mut guest/agent/agent.go 's/if s > a.cfg.SessionMax {/if false {/' guest/agent 'TestSessionMaxIsCappedByTheAgent' "a session may ask for any length"
mut guest/agent/agent.go 's/timeout = s + a.cfg.SessionGrace/timeout = s + 100*time.Hour/' guest/agent 'TestSessionTimeoutComesFromMaxS|TestSessionMaxIsCappedByTheAgent' "the session deadline is far away"
mut guest/agent/agent.go 's/_ = conn.SetReadDeadline(time.Now().Add(a.cfg.ReadJobTimeout))/_ = 0/' guest/agent 'TestNoNewlineTimesOut' "no deadline for reading the job"
mut guest/agent/agent.go 's/stop(reasonOversize)/_ = reasonOversize/' guest/agent 'TestOversizeIsCappedAndKilled' "no cap on the output"
mut guest/agent/agent.go 's/^\t\t\t_ = out.Close()$/\t\t\t_ = 0/' guest/agent 'TestTimeoutHoldsWhenAProcessLeavesTheGroupAndKeepsTheOutput' "the output stays open after the job ended"
mut guest/agent/agent.go 's/cmd.Env = a.cfg.Env/cmd.Env = nil/' guest/agent 'TestMinimalEnvironment' "the job inherits the agent's environment"
mut guest/agent/agent.go 's/if !a.busy.CompareAndSwap(false, true) {/if false {/' guest/agent 'TestBusyWhileJobRuns|TestSessionSlotIsBusyWhileTheSessionRuns' "two jobs at once"
mut guest/agent/agent.go 's/needNL := last != .\\n./needNL := last != 0 \&\& false/' guest/agent 'TestStatusOnOwnLineWhenOutputHasNoNewline|TestCollectorCannotForgeFinalStatus' "the final status can share a line with the output"
mut guest/agent/agent.go 's/if len(body) > a.cfg.MaxCmd || body\[0\] != .{. || !json.Valid(body) {/if false {/' guest/agent 'TestBadCommandEndsTheJobAndKillsTheCollector' "any line is a command"
mut guest/agent/agent.go 's/if count > a.cfg.MaxCmds {/if false {/' guest/agent 'TestTooManyCommands' "no limit on the number of commands"

# ---- the supervisor's input checks and its record store (added 9 Nov 2026): session ranges, settings, files on disk ----
mut supervisor/api.go 's/f != math.Trunc(f)/math.Trunc(f) != math.Trunc(f)/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "a session limit may be a fraction"
mut supervisor/api.go 's/ || f < min || f > max {/ || f > max {/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "no lower bound on a session limit"
mut supervisor/api.go 's/ || f > max {/ || f > max*1e9 {/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "no upper bound on a session limit"
mut supervisor/api.go 's/wholeNumber(raw, 5, 120)/wholeNumber(raw, 0, 120)/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "idle_s may be shorter than 5"
mut supervisor/api.go 's/wholeNumber(raw, 5, 120)/wholeNumber(raw, 5, 1200)/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "idle_s may be longer than 120"
mut supervisor/api.go 's/wholeNumber(raw, 30, 600)/wholeNumber(raw, 1, 600)/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "max_s may be shorter than 30"
mut supervisor/api.go 's/wholeNumber(raw, 30, 600)/wholeNumber(raw, 30, 6000)/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "max_s may be longer than 600"
mut supervisor/api.go 's/if k != "idle_s" \&\& k != "max_s" {/if false {/' supervisor 'TestAPISessions_ValidateSubmit_SessionField' "an unknown session field is accepted"
mut supervisor/config.go 's/if err != nil || v < min || v > max {/if err != nil || v > max {/' supervisor 'TestConfig_OutOfRangeOrMalformedValuesStopTheService|TestConfig_BoundariesAreInclusiveAndEmptyMeansDefault' "a setting below its range is accepted"
mut supervisor/config.go 's/if err != nil || v < min || v > max {/if err != nil || v < min {/' supervisor 'TestConfig_OutOfRangeOrMalformedValuesStopTheService|TestConfig_BoundariesAreInclusiveAndEmptyMeansDefault' "a setting above its range is accepted"
mut supervisor/config.go 's/if !digitsRe.MatchString(raw) {/if false {/' supervisor 'TestConfig_OutOfRangeOrMalformedValuesStopTheService' "a setting that is not plain digits is accepted"
mut supervisor/store.go 's/tmp := s.path(rec.ID) + ".tmp"/tmp := s.path(rec.ID)/' supervisor 'TestStore_RecordsStayPrivateAndAreReplacedByRename' "a record is written in place, not to a temporary name and renamed"
mut supervisor/store.go 's/if strings.HasSuffix(name, ".tmp") {/if false {/' supervisor 'TestStore_DamagedFileAndStrayTmpDoNotFailStartup' "a stray temporary file is not cleaned at start"
mut supervisor/store.go 's/os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)/os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)/' supervisor 'TestStore_RecordsStayPrivateAndAreReplacedByRename' "a record is readable by everybody"
mut supervisor/store.go 's/if err := os.MkdirAll(dir, 0o700); err != nil {/if err := os.MkdirAll(dir, 0o755); err != nil {/' supervisor 'TestStore_RecordsStayPrivateAndAreReplacedByRename' "the records directory is open to everybody"

# ---- the host's measure of the microVM's processor time (supervisor/cpu.go, added 9 Nov 2026) ----
mut supervisor/cpu.go 's/ (atMs < m.samples\[n-1\].atMs || cpu < m.samples\[n-1\].cpu)/ false/' supervisor 'TestCPU_AClockOrACounterThatGoesBackIsNotBelieved' "a counter that goes back is believed"
mut supervisor/cpu.go 's/if len(m.samples) >= cpuSamplesMax {/if false {/' supervisor 'TestCPU_SamplesAreCapped' "the samples have no cap"
mut supervisor/cpu.go 's/if n < 2 {/if n < 1 {/' supervisor 'TestCPU_NoSummaryWithoutTwoSamples' "a summary from one sample"
mut supervisor/cpu.go 's/last.atMs-m.samples\[i\].atMs >= cpuTail.Milliseconds()/last.atMs-m.samples[i].atMs > cpuTail.Milliseconds()/' supervisor 'TestCPU_SummaryTotalsAndTheLastThreeSeconds' "the tail is a little longer than three seconds"
mut supervisor/cpu.go 's/TotalMs:    (last.cpu - first.cpu).Milliseconds(),/TotalMs:    last.cpu.Milliseconds(),/' supervisor 'TestCPU_SummaryTotalsAndTheLastThreeSeconds|TestCPU_SummaryOfARunShorterThanTheTailIsTheWholeRun' "the total counts the boot too"
mut supervisor/cpu.go 's/TailWallMs: last.atMs - from.atMs,/TailWallMs: last.atMs - first.atMs,/' supervisor 'TestCPU_SummaryTotalsAndTheLastThreeSeconds' "the tail's wall time is the whole run's"
mut supervisor/firecracker.go 's/if err != nil || n < 0 {/if err != nil {/' supervisor 'TestCPU_SystemctlAnswerIsANumberOfNanosecondsOrUnknown' "a negative reading is believed"
mut supervisor/run.go 's/rec.VMCPU = r.cpu.summary()/rec.VMCPU = nil/' supervisor 'TestCore_TheHostMeasuresTheVMsProcessorTime' "the measure is not kept in the record"
mut supervisor/cpu.go 's/^\t\tr.cpu.add(r.s.now(), cpu)$/\t\t_ = cpu/' supervisor 'TestCore_TheHostMeasuresTheVMsProcessorTime|TestCore_TheLastReadingIsTakenBeforeTheVMStops' "the readings are thrown away"
mut supervisor/run.go 's/^\t\tr.takeCPU(r.vm) \/\/ the VM is still up: its counter ends with the unit$/\t\t_ = r.vm/' supervisor 'TestCore_TheLastReadingIsTakenBeforeTheVMStops' "no last reading before the VM stops"

echo "mutations: $total, problems: $fails${skipped:+, skipped for lack of root: $skipped}"
exit $((fails > 0))
