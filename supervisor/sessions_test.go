package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func sessionsTLimits() SessionLimits { return SessionLimits{IdleMs: 5000, MaxMs: 3000} }

// sessionsTScript is the evidence the collector prints before the session starts, then the ready marker; the stream stays open.
func sessionsTScript(over ...func(*Script)) Script {
	s := Script{Lines: []string{`{"type":"evidence","v":1,"kind":"nav"}`, sessionReady}, Hang: true}
	for _, f := range over {
		f(&s)
	}
	return s
}

func sessionsTStart(t *testing.T, h *Harness, path string, lim SessionLimits) (string, *FakeVM) {
	t.Helper()
	id := h.submitSession(t, path, lim)
	h.waitState(t, id, StateSession)
	return id, h.Backend.VM(id)
}

// sessionsTCmd submits a command the way the HTTP layer hands it over (decoded JSON) and requires it to be accepted.
func sessionsTCmd(t *testing.T, h *Harness, id string, cmd map[string]any) SubmitOK {
	t.Helper()
	ok, err := sessionsTSubmit(h, id, cmd)
	if err != nil {
		t.Fatalf("command %v refused: %v", cmd, err)
	}
	return ok
}

func sessionsTSubmit(h *Harness, id string, cmd map[string]any) (SubmitOK, *CmdError) {
	raw, _ := json.Marshal(cmd)
	var body any
	_ = json.Unmarshal(raw, &body)
	return h.Sup.SubmitCommand(id, body)
}

func sessionsTCode(e *CmdError) string {
	if e == nil {
		return ""
	}
	return e.Code
}

func sessionsTJob(t *testing.T, vm *FakeVM) map[string]any {
	t.Helper()
	var job map[string]any
	if err := json.Unmarshal([]byte(vm.Job()), &job); err != nil {
		t.Fatalf("job %q: %v", vm.Job(), err)
	}
	return job
}

func sessionsTHas(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func sessionsTReason(v RunView) string {
	if v.Reason == nil {
		return ""
	}
	return string(*v.Reason)
}

func sessionsTBoot300(c *Config) { c.BootTimeout = 300 * time.Millisecond }

func TestSessions_PassesThroughSessionStateTakesCommandsEndsDoneAfterClose(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, sessionsTBoot300)
	h.start(t)
	id, vm := sessionsTStart(t, h, "/s", sessionsTLimits())

	job := sessionsTJob(t, vm)
	if !reflect.DeepEqual(job["session"], map[string]any{"max_s": float64(3)}) {
		t.Fatalf("job session = %v (the guest gets the total time only; idle belongs to the supervisor)", job["session"])
	}
	if _, has := job["idle_s"]; has {
		t.Fatal("job carries idle_s")
	}

	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "c1"})
	sessionsTCmd(t, h, id, map[string]any{"cmd": "scroll", "id": "c2", "dy": 200})
	waitFor(t, "c2 done", func() bool { return sessionsTHas(h.statusesOf(id, "c2"), "done") })
	sessionsTCmd(t, h, id, map[string]any{"cmd": "close", "id": "c3"})

	v := h.finished(t, id)
	if v.State != StateDone || v.AgentStatus == nil || *v.AgentStatus != "ok" {
		t.Fatalf("view = %+v", v)
	}
	wantSent := []string{`{"cmd":"snapshot","id":"c1"}`, `{"cmd":"scroll","dy":200,"id":"c2"}`, `{"cmd":"close","id":"c3"}`}
	if got := vm.Sent(); !reflect.DeepEqual(got, wantSent) {
		t.Fatalf("sent = %v", got)
	}
	want := []string{"accepted", "sent", "done"}
	for _, c := range []string{"c1", "c3"} {
		if got := h.statusesOf(id, c); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s statuses = %v", c, got)
		}
	}
	wantStates := []string{"queued", "preparing", "booting", "running", "session", "destroying", "done"}
	if got := dedupe(h.states(id)); !reflect.DeepEqual(got, wantStates) {
		t.Fatalf("states = %v", got)
	}
	if v.Session == nil || *v.Session != (SessionView{IdleS: 5, MaxS: 3}) {
		t.Fatalf("session = %+v", v.Session)
	}
	if v.Commands == nil || *v.Commands != (CommandCounts{Total: 3, AwaitingApproval: 0}) {
		t.Fatalf("commands = %+v", v.Commands)
	}
	h.idle(t)
}

func TestSessions_EvidenceIsPublishedAsItArrivesNotOneLineLate(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, sessionsTBoot300)
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", sessionsTLimits())
	ev := h.evidence(id)
	if len(ev) != 2 {
		t.Fatalf("%d evidence lines, the last line before the pause must already be visible: %v", len(ev), ev)
	}
	if !strings.Contains(ev[1], "session_ready") {
		t.Fatalf("second line = %s", ev[1])
	}
	h.Sup.Cancel(id)
	h.finished(t, id)
}

func TestSessions_CommandsRefusedBeforeReadyForOneShotAndUnknownRuns(t *testing.T) {
	h := newHarness(t, map[string]Script{"/slow": {Hang: true}, "/oneshot": {Hang: true}}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.HardTimeout = 3 * time.Second
	})
	h.start(t)
	if _, err := sessionsTSubmit(h, "99999999-9999-4999-8999-999999999999", map[string]any{"cmd": "snapshot", "id": "a"}); sessionsTCode(err) != "not_found" {
		t.Fatalf("unknown run: %v", err)
	}

	one := h.submit(t, "/oneshot")
	h.waitState(t, one, StateRunning)
	if _, err := sessionsTSubmit(h, one, map[string]any{"cmd": "snapshot", "id": "a"}); sessionsTCode(err) != "not_session" {
		t.Fatalf("one-shot run: %v", err)
	}
	if v, _ := h.Sup.Get(one); v.Session != nil {
		t.Fatalf("one-shot run has a session view: %+v", v.Session)
	}

	early := h.submitSession(t, "/slow", sessionsTLimits()) // never says session_ready
	h.waitState(t, early, StateRunning)
	if _, err := sessionsTSubmit(h, early, map[string]any{"cmd": "snapshot", "id": "a"}); sessionsTCode(err) != "not_session" {
		t.Fatalf("session before ready: %v", err)
	}
	h.Sup.Cancel(one)
	h.Sup.Cancel(early)
	h.finished(t, one)
	h.finished(t, early)
	h.idle(t)
}

func TestSessions_RiskyCommandHeldUntilApprovalWithItsHash(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, sessionsTBoot300)
	h.start(t)
	id, vm := sessionsTStart(t, h, "/s", sessionsTLimits())

	d := sessionsTCmd(t, h, id, map[string]any{"cmd": "download", "id": "dl", "snap": 1, "ref": "e5"})
	if d.Status != CmdAwaitingApproval {
		t.Fatalf("status = %s", d.Status)
	}
	sleep(30 * time.Millisecond) // nothing must happen in this time
	if got := vm.Sent(); len(got) != 0 {
		t.Fatalf("reached the guest before approval: %v", got)
	}
	if v, _ := h.Sup.Get(id); v.Commands == nil || *v.Commands != (CommandCounts{Total: 1, AwaitingApproval: 1}) {
		t.Fatalf("commands = %+v", v.Commands)
	}

	if err := h.Sup.ApproveCommand(id, "dl", strings.Repeat("f", 64)); sessionsTCode(err) != "hash_mismatch" {
		t.Fatalf("wrong hash: %v", err)
	}
	if got := vm.Sent(); len(got) != 0 {
		t.Fatalf("reached the guest after a wrong hash: %v", got)
	}

	if err := h.Sup.ApproveCommand(id, "dl", d.SHA256); err != nil {
		t.Fatalf("approve: %v", err)
	}
	waitFor(t, "dl done", func() bool { return sessionsTHas(h.statusesOf(id, "dl"), "done") })
	if got := vm.Sent(); !reflect.DeepEqual(got, []string{`{"cmd":"download","id":"dl","ref":"e5","snap":1}`}) {
		t.Fatalf("sent = %v", got)
	}
	want := []string{"accepted", "awaiting_approval", "approved", "sent", "done"}
	if got := h.statusesOf(id, "dl"); !reflect.DeepEqual(got, want) {
		t.Fatalf("statuses = %v", got)
	}
	if err := h.Sup.ApproveCommand(id, "dl", d.SHA256); sessionsTCode(err) != "not_waiting" {
		t.Fatalf("second approval: %v", err)
	}
	if n := len(vm.Sent()); n != 1 {
		t.Fatalf("%d lines sent", n)
	}

	sessionsTCmd(t, h, id, map[string]any{"cmd": "close", "id": "bye"})
	h.finished(t, id)
	h.idle(t)
}

func TestSessions_RejectingWaitingCommandVoidsNothingElse(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, sessionsTBoot300)
	h.start(t)
	id, vm := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "download", "id": "dl", "snap": 1, "ref": "e5"})
	if err := h.Sup.RejectCommand(id, "dl"); err != nil {
		t.Fatalf("reject: %v", err)
	}
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "next"})
	waitFor(t, "next done", func() bool { return sessionsTHas(h.statusesOf(id, "next"), "done") })
	if got := vm.Sent(); !reflect.DeepEqual(got, []string{`{"cmd":"snapshot","id":"next"}`}) {
		t.Fatalf("sent = %v", got)
	}
	if err := h.Sup.RejectCommand(id, "nope"); sessionsTCode(err) != "not_found" {
		t.Fatalf("missing command: %v", err)
	}
	if err := h.Sup.RejectCommand("99999999-9999-4999-8999-999999999999", "dl"); sessionsTCode(err) != "not_found" {
		t.Fatalf("missing run: %v", err)
	}
	h.Sup.Cancel(id)
	h.finished(t, id)
}

func TestSessions_UnansweredApprovalExpiresAndDoesNotKeepRunAlive(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.ApprovalTTL = 60 * time.Millisecond
	})
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", SessionLimits{IdleMs: 60, MaxMs: 3000})
	d := sessionsTCmd(t, h, id, map[string]any{"cmd": "download", "id": "dl", "snap": 1, "ref": "e5"})
	waitFor(t, "dl expired", func() bool { return sessionsTHas(h.statusesOf(id, "dl"), "expired") })
	if err := h.Sup.ApproveCommand(id, "dl", d.SHA256); sessionsTCode(err) != "expired" {
		t.Fatalf("late approval: %v", err)
	}
	v := h.finished(t, id) // the idle clock restarted after the expiry and closed the session
	if v.State != StateDone {
		t.Fatalf("state = %s", v.State)
	}
	h.idle(t)
}

func TestSessions_IdleSupervisorClosesUnusedSession(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, sessionsTBoot300)
	h.start(t)
	id, vm := sessionsTStart(t, h, "/s", SessionLimits{IdleMs: 60, MaxMs: 3000})
	v := h.finished(t, id)
	if v.State != StateDone {
		t.Fatalf("state = %s", v.State)
	}
	if got := vm.Sent(); !reflect.DeepEqual(got, []string{`{"cmd":"close","id":"idle-close"}`}) {
		t.Fatalf("sent = %v", got)
	}
	found := false
	for _, c := range h.commandEvents(id) {
		if c.CommandID == "idle-close" {
			found = true
			if c.By != "supervisor" {
				t.Fatalf("idle-close by %q", c.By)
			}
		}
	}
	if !found {
		t.Fatal("no idle-close event")
	}
	h.idle(t)
}

func TestSessions_UnansweredCommandEndsRunWithTimeoutEvidenceKeptAsPartial(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) { s.Silent = true })}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.CommandTimeout = 60 * time.Millisecond
	})
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "stuck"})
	sessionsTCmd(t, h, id, map[string]any{"cmd": "wait", "id": "queued", "ms": 10})
	v := h.finished(t, id)
	if v.State != StateFailed || sessionsTReason(v) != "timeout" || !v.Partial {
		t.Fatalf("state %s reason %q partial %v", v.State, sessionsTReason(v), v.Partial)
	}
	if got := h.statusesOf(id, "stuck"); !reflect.DeepEqual(got, []string{"accepted", "sent", "timeout"}) {
		t.Fatalf("stuck = %v", got)
	}
	if got := h.statusesOf(id, "queued"); !reflect.DeepEqual(got, []string{"accepted", "voided"}) {
		t.Fatalf("queued = %v", got)
	}
	h.idle(t)
}

func TestSessions_SupervisorCeilingEndsSessionThatIgnoresCloseAndTimeLimit(t *testing.T) {
	stubborn := sessionsTScript(func(s *Script) { s.OnCommand = func(map[string]any, *FakeVM) {} })
	h := newHarness(t, map[string]Script{"*": stubborn}, func(c *Config) {
		c.BootTimeout = 100 * time.Millisecond
		c.SessionGrace = 60 * time.Millisecond
		c.HardTimeout = 5 * time.Second
	})
	h.start(t)
	begun := time.Now()
	id, _ := sessionsTStart(t, h, "/s", SessionLimits{IdleMs: 5000, MaxMs: 120}) // ceiling: 100 + 120 + 60 ms
	sessionsTCmd(t, h, id, map[string]any{"cmd": "close", "id": "bye"})
	v := h.finished(t, id)
	if v.State != StateFailed || sessionsTReason(v) != "timeout" {
		t.Fatalf("state %s reason %q", v.State, sessionsTReason(v))
	}
	if d := time.Since(begun); d >= 1500*time.Millisecond {
		t.Fatalf("took %v: ended by the 5 s one-shot limit, not by the session ceiling", d)
	}
	if got := h.statusesOf(id, "bye"); !reflect.DeepEqual(got, []string{"accepted", "sent", "done"}) {
		t.Fatalf("a sent close counts as done once the run is over: %v", got)
	}
	h.idle(t)
}

func TestSessions_NotCutOffByOneShotHardTimeout(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.HardTimeout = 100 * time.Millisecond
	})
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", SessionLimits{IdleMs: 5000, MaxMs: 2000})
	sleep(250 * time.Millisecond) // nothing must happen: the one-shot limit (100 ms) has passed twice over
	if h.state(id) != StateSession {
		t.Fatalf("state = %s", h.state(id))
	}
	h.Sup.Cancel(id)
	h.finished(t, id)
}

func TestSessions_CancelVoidsWhatIsOpenAndFreesEverything(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) { s.Silent = true })}, sessionsTBoot300)
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "a"})
	sessionsTCmd(t, h, id, map[string]any{"cmd": "download", "id": "d", "snap": 1, "ref": "e1"})
	if got := h.Sup.Cancel(id); got != "cancelling" {
		t.Fatalf("cancel = %s", got)
	}
	v := h.finished(t, id)
	if sessionsTReason(v) != "cancelled" {
		t.Fatalf("reason %q", sessionsTReason(v))
	}
	if got := h.statusesOf(id, "a"); !reflect.DeepEqual(got, []string{"accepted", "sent", "voided"}) {
		t.Fatalf("a = %v", got)
	}
	if got := h.statusesOf(id, "d"); !reflect.DeepEqual(got, []string{"accepted", "awaiting_approval", "voided"}) {
		t.Fatalf("d = %v", got)
	}
	if _, err := sessionsTSubmit(h, id, map[string]any{"cmd": "snapshot", "id": "late"}); sessionsTCode(err) != "not_session" {
		t.Fatalf("late command: %v", err)
	}
	if err := h.Sup.ApproveCommand(id, "d", strings.Repeat("a", 64)); sessionsTCode(err) != "not_session" {
		t.Fatalf("late approval: %v", err)
	}
	h.idle(t)
}

func TestSessions_FailureToWriteCommandEndsRunAsAgentError(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) { s.SendFails = true })}, sessionsTBoot300)
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "a"})
	v := h.finished(t, id)
	if sessionsTReason(v) != "agent_error" {
		t.Fatalf("reason %q", sessionsTReason(v))
	}
	h.idle(t)
}

func TestSessions_AgentRejectingCommandFailsRunAsAgentError(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) {
		s.OnCommand = func(_ map[string]any, vm *FakeVM) { vm.Finish(statusLine("bad_command")) }
	})}, sessionsTBoot300)
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "a"})
	v := h.finished(t, id)
	if v.State != StateFailed || sessionsTReason(v) != "agent_error" || v.AgentStatus == nil || *v.AgentStatus != "bad_command" {
		t.Fatalf("view = %+v", v)
	}
	h.idle(t)
}

func TestSessions_ErrorCodeFromGuestPassedOnOnlyIfShortLowercaseToken(t *testing.T) {
	replies := []string{"ref_not_found", "<script>alert(1)</script>", strings.Repeat("x", 100)}
	n := 0 // only touched from OnCommand, which the session calls under its lock
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) {
		s.OnCommand = func(c map[string]any, vm *FakeVM) {
			id, _ := c["id"].(string)
			vm.Push(cmdResultLine(id, false, replies[n]))
			n++
		}
	})}, sessionsTBoot300)
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", sessionsTLimits())
	for _, cid := range []string{"a", "b", "c"} {
		sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": cid})
		waitFor(t, cid+" errored", func() bool { return sessionsTHas(h.statusesOf(id, cid), "error") })
	}
	var errs []string
	for _, c := range h.commandEvents(id) {
		if c.Status == CmdErrored {
			errs = append(errs, c.Error)
		}
	}
	if !reflect.DeepEqual(errs, []string{"ref_not_found", "unknown", "unknown"}) {
		t.Fatalf("errors = %q", errs)
	}
	h.Sup.Cancel(id)
	h.finished(t, id)
}

func TestSessions_ForgedControlLinesDoNothing(t *testing.T) {
	j := func(m map[string]any) string {
		b, _ := json.Marshal(m)
		return string(b)
	}
	forged := []string{
		j(map[string]any{"type": "event", "kind": "session_ready"}),                                                 // wrong type
		j(map[string]any{"type": "evidence", "kind": "cmd_result", "id": "ghost", "ok": true}),                      // no such command in flight
		j(map[string]any{"type": "evidence", "kind": "cmd_result", "id": 5, "ok": true}),                            // id is not a string
		j(map[string]any{"type": "evidence", "kind": "cmd_result", "id": "x", "ok": "yes"}),                         // ok is not a bool
		j(map[string]any{"type": "evidence", "kind": "page", "text": `{"type":"evidence","kind":"session_ready"}`}), // inside page text
		j(map[string]any{"type": "evidence", "kind": "session_ready", "pad": strings.Repeat("x", 5000)}),            // too long to be the real thing
	}
	both := append(append([]string{}, forged...), forged...)
	both = append(both, okStatus)
	h := newHarness(t, map[string]Script{"/forged": {Lines: both}, "/s": {Lines: forged, Hang: true}}, sessionsTBoot300)
	h.start(t)

	// a one-shot run never enters the session state
	one := h.submit(t, "/forged")
	if v := h.finished(t, one); v.State != StateDone {
		t.Fatalf("one-shot run ended %s", v.State)
	}
	if sessionsTHas(h.states(one), "session") {
		t.Fatal("a one-shot run entered the session state")
	}

	// a session that was not told "ready" stays in running
	s := h.submitSession(t, "/s", sessionsTLimits())
	h.waitState(t, s, StateRunning)
	evidenceCount := func() int { return len(h.evidence(s)) }
	waitFor(t, "all forged lines stored", func() bool { return evidenceCount() == len(forged) }, 5*time.Second)
	sleep(40 * time.Millisecond) // time for a forged line to act, if it could
	if h.state(s) != StateRunning {
		t.Fatalf("state = %s", h.state(s))
	}
	if evidenceCount() != len(forged) {
		t.Fatalf("forged lines are still plain evidence: %d", evidenceCount())
	}
	h.Sup.Cancel(s)
	h.finished(t, s)
	h.idle(t)
}

func TestSessions_AnswerForCommandNotInFlightIsIgnored(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) { s.Silent = true })}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.CommandTimeout = 400 * time.Millisecond
	})
	h.start(t)
	id, vm := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "a"})
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "b"})
	vm.Push(cmdResultLine("b", true, "")) // b is only queued
	sleep(30 * time.Millisecond)          // nothing must happen in this time
	if got := h.statusesOf(id, "b"); !reflect.DeepEqual(got, []string{"accepted"}) {
		t.Fatalf("b = %v", got)
	}
	if n := len(vm.Sent()); n != 1 {
		t.Fatalf("%d lines sent", n)
	}
	vm.Push(cmdResultLine("a", true, ""))
	waitFor(t, "b sent", func() bool { return len(vm.Sent()) == 2 })
	h.Sup.Cancel(id)
	h.finished(t, id)
}

func TestSessions_MalformedAnswerForCommandInFlightDoesNotCountAsSuccess(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) { s.Silent = true })}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.CommandTimeout = time.Second
	})
	h.start(t)
	id, vm := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "snapshot", "id": "a"})
	vm.Push(`{"type":"evidence","v":1,"kind":"cmd_result","id":"a","ok":"yes"}`)
	vm.Push(`{"type":"evidence","v":1,"kind":"cmd_result","id":"a"}`)
	vm.Push(`{"type":"evidence","v":1,"kind":"cmd_result","id":"a","ok":1}`)
	sleep(40 * time.Millisecond) // nothing must happen in this time
	if got := h.statusesOf(id, "a"); !reflect.DeepEqual(got, []string{"accepted", "sent"}) {
		t.Fatalf("a = %v", got)
	}
	vm.Push(cmdResultLine("a", true, ""))
	waitFor(t, "a done", func() bool { return sessionsTHas(h.statusesOf(id, "a"), "done") })
	h.Sup.Cancel(id)
	h.finished(t, id)
}

func TestSessions_SlotsSecondSessionWaitsPlainRunsPassItStartsWhenFirstEnds(t *testing.T) {
	h := newHarness(t, map[string]Script{"/s1": sessionsTScript(), "/s2": sessionsTScript(), "/plain": {Lines: []string{okStatus}}}, func(c *Config) {
		c.Concurrency = 3
		c.SessionSlots = 1
		c.BootTimeout = 300 * time.Millisecond
	})
	h.start(t)
	first, _ := sessionsTStart(t, h, "/s1", sessionsTLimits())
	second := h.submitSession(t, "/s2", sessionsTLimits())
	plain := h.submit(t, "/plain")
	if v := h.finished(t, plain); v.State != StateDone {
		t.Fatalf("a plain run is not held up by a waiting session: %s", v.State)
	}
	v, _ := h.Sup.Get(second)
	if v.State != StateQueued || v.Position == nil || *v.Position != 1 {
		t.Fatalf("second = %s position %v", v.State, v.Position)
	}
	if got := h.Sup.Health().Sessions; got != (SessionsHealth{Running: 1, Limit: 1}) {
		t.Fatalf("sessions = %+v", got)
	}

	sessionsTCmd(t, h, first, map[string]any{"cmd": "close", "id": "bye"})
	h.finished(t, first)
	h.waitState(t, second, StateSession)
	if got := h.Sup.Health().Sessions; got != (SessionsHealth{Running: 1, Limit: 1}) {
		t.Fatalf("sessions = %+v", got)
	}
	h.Sup.Cancel(second)
	h.finished(t, second)
	if got := h.Sup.Health().Sessions; got != (SessionsHealth{Running: 0, Limit: 1}) {
		t.Fatalf("sessions = %+v", got)
	}
	h.idle(t)
}

func TestSessions_SwitchedOffRequestIsRefusedInsteadOfWaitingForever(t *testing.T) {
	h := newHarness(t, map[string]Script{}, func(c *Config) { c.SessionSlots = 0 })
	h.start(t)
	lim := sessionsTLimits()
	if _, err := h.Sup.Submit(urlOf("/s"), &lim); err != ErrSessionsDisabled {
		t.Fatalf("session submit: %v", err)
	}
	if _, err := h.Sup.Submit(urlOf("/plain"), nil); err != nil {
		t.Fatalf("plain submit: %v", err)
	}
}

func TestSessions_RecoveryAliveSessionFailsOpenCommandsVoidedInLog(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{okStatus}}}, nil)
	const id = "44444444-4444-4444-8444-444444444444"
	now := time.Now().UnixMilli()
	lim := sessionsTLimits()
	if err := h.Store.Insert(RunRecord{ID: id, URL: urlOf("/dead"), CreatedAt: now - 1000, ExpiresAt: now + 100000, Session: &lim}); err != nil {
		t.Fatal(err)
	}
	if err := h.Store.Update(id, func(r *RunRecord) {
		r.State = StateSession
		r.Slot = ptr(0)
		r.StartedAt = ptr(now - 900)
	}); err != nil {
		t.Fatal(err)
	}
	cmdEvent := func(seq int, commandID, st string) {
		t.Helper()
		data, _ := json.Marshal(map[string]any{"command_id": commandID, "cmd": "download", "status": st, "risk": "risky", "command_sha256": strings.Repeat("ab", 32)})
		if err := h.Results.Append(id, RunEvent{Seq: seq, Type: "command", Data: string(data)}); err != nil {
			t.Fatal(err)
		}
	}
	cmdEvent(1, "waiting", "awaiting_approval")
	cmdEvent(2, "sent-one", "sent")
	cmdEvent(3, "finished", "sent")
	cmdEvent(4, "finished", "done")
	h.start(t)
	v, _ := h.Sup.Get(id)
	if v.State != StateFailed || sessionsTReason(v) != "supervisor_restart" {
		t.Fatalf("view = %+v", v)
	}
	var order []string
	last := map[string]string{}
	for _, c := range h.commandEvents(id) {
		if _, seen := last[c.CommandID]; !seen {
			order = append(order, c.CommandID)
		}
		last[c.CommandID] = string(c.Status)
	}
	got := make([]string, 0, len(order))
	for _, cid := range order {
		got = append(got, cid+"="+last[cid])
	}
	if want := []string{"waiting=voided", "sent-one=voided", "finished=done"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("final statuses = %v, want %v", got, want)
	}
}

func TestSessions_QueuedSessionSurvivesRestartWithItsLimits(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, sessionsTBoot300)
	const id = "55555555-5555-4555-8555-555555555555"
	now := time.Now().UnixMilli()
	lim := SessionLimits{IdleMs: 7000, MaxMs: 9000}
	if err := h.Store.Insert(RunRecord{ID: id, URL: urlOf("/queued"), CreatedAt: now - 100, ExpiresAt: now + 100000, Session: &lim}); err != nil {
		t.Fatal(err)
	}
	if rec, _ := h.Store.Get(id); rec.Session == nil || *rec.Session != lim {
		t.Fatalf("stored limits = %+v", rec.Session)
	}
	h.start(t)
	h.waitState(t, id, StateSession)
	if job := sessionsTJob(t, h.Backend.VM(id)); !reflect.DeepEqual(job["session"], map[string]any{"max_s": float64(9)}) {
		t.Fatalf("job session = %v", job["session"])
	}
	h.Sup.Cancel(id)
	h.finished(t, id)
}

func TestSessions_ShutdownWhileOpenVoidsCommandsAndLeavesNothingBehind(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript(func(s *Script) { s.Silent = true })}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.ShutdownGrace = 80 * time.Millisecond
	})
	h.start(t)
	id, _ := sessionsTStart(t, h, "/s", sessionsTLimits())
	sessionsTCmd(t, h, id, map[string]any{"cmd": "download", "id": "d", "snap": 1, "ref": "e1"})
	h.Sup.Shutdown()
	if v, _ := h.Sup.Get(id); sessionsTReason(v) != "supervisor_restart" {
		t.Fatalf("reason %q", sessionsTReason(v))
	}
	if got := h.statusesOf(id, "d"); !reflect.DeepEqual(got, []string{"accepted", "awaiting_approval", "voided"}) {
		t.Fatalf("d = %v", got)
	}
	h.Backend.AssertClean(t)
}

// Commands and approvals that arrive from many goroutines at once (the HTTP layer does
// this) must neither race nor lose or double-send a command. Run with -race.
func TestSessions_ConcurrentSubmissionsSendEachCommandOnce(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, sessionsTBoot300)
	h.start(t)
	id, vm := sessionsTStart(t, h, "/s", sessionsTLimits())
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := sessionsTSubmit(h, id, map[string]any{"cmd": "snapshot", "id": fmt.Sprintf("c%d", i)}); err != nil {
				t.Errorf("c%d: %v", i, err)
			}
			h.Sup.Get(id)
		}(i)
	}
	wg.Wait()
	waitFor(t, "all commands sent", func() bool { return len(vm.Sent()) == n })
	seen := map[string]bool{}
	for _, l := range vm.Sent() {
		if seen[l] {
			t.Fatalf("sent twice: %s", l)
		}
		seen[l] = true
	}
	waitFor(t, "all commands done", func() bool {
		v, _ := h.Sup.Get(id)
		return v.Commands != nil && v.Commands.Total == n && len(h.commandEvents(id)) >= 3*n
	})
	h.Sup.Cancel(id)
	h.finished(t, id)
	h.idle(t)
}

// The guest is told the total time rounded up (at least one second); the view rounds to the nearest second.
func TestSessions_LimitsAreRoundedForGuestAndView(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": sessionsTScript()}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.Concurrency = 2
		c.SessionSlots = 2
	})
	h.start(t)
	a, vmA := sessionsTStart(t, h, "/a", SessionLimits{IdleMs: 4600, MaxMs: 2400})
	b, vmB := sessionsTStart(t, h, "/b", SessionLimits{IdleMs: 5000, MaxMs: 100})
	if job := sessionsTJob(t, vmA); !reflect.DeepEqual(job["session"], map[string]any{"max_s": float64(3)}) {
		t.Fatalf("job session = %v", job["session"])
	}
	if job := sessionsTJob(t, vmB); !reflect.DeepEqual(job["session"], map[string]any{"max_s": float64(1)}) {
		t.Fatalf("job session = %v", job["session"])
	}
	if v, _ := h.Sup.Get(a); v.Session == nil || *v.Session != (SessionView{IdleS: 5, MaxS: 2}) {
		t.Fatalf("view session = %+v", v.Session)
	}
	h.Sup.Cancel(a)
	h.Sup.Cancel(b)
	h.finished(t, a)
	h.finished(t, b)
	h.idle(t)
}
