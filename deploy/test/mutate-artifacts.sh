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

mut() { # file  sed-expression  directory  go-test-regex  label
  local file=$1 expr=$2 dir=$3 re=$4 label=$5
  total=$((total + 1))
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

echo "mutations: $total, problems: $fails"
exit $((fails > 0))
