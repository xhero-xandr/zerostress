package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The session calls Send, Emit and Abort from timer goroutines, so the
// recorders below are guarded by a mutex of their own (never held while calling into the session).

type sessTH struct {
	t      *testing.T
	s      *SessionCommands
	mu     sync.Mutex
	sent   []string
	events []CommandEvent
	aborts []*RunError
}

func sessTMake(t *testing.T, over ...func(*SessionOptions)) *sessTH {
	t.Helper()
	h := &sessTH{t: t}
	o := SessionOptions{
		Idle:           10 * time.Second,
		CommandMax:     50,
		CommandTimeout: 10 * time.Second,
		ApprovalTTL:    10 * time.Second,
		Now:            func() int64 { return time.Now().UnixMilli() },
		Send: func(line string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.sent = append(h.sent, line)
			return nil
		},
		Emit: func(ev CommandEvent) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.events = append(h.events, ev)
		},
		Abort: func(e *RunError) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.aborts = append(h.aborts, e)
		},
	}
	for _, f := range over {
		f(&o)
	}
	h.s = NewSessionCommands(o)
	t.Cleanup(h.s.End) // stops every timer, also when a test fails half way
	return h
}

func (h *sessTH) sentLines() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.sent...)
}

func (h *sessTH) nSent() int { return len(h.sentLines()) }

func (h *sessTH) lastSent() string {
	l := h.sentLines()
	if len(l) == 0 {
		h.t.Fatal("nothing was sent")
	}
	return l[len(l)-1]
}

func (h *sessTH) eventList() []CommandEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]CommandEvent(nil), h.events...)
}

func (h *sessTH) abortList() []*RunError {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]*RunError(nil), h.aborts...)
}

func (h *sessTH) statuses(id string) []string {
	out := []string{}
	for _, e := range h.eventList() {
		if e.CommandID == id {
			out = append(out, string(e.Status))
		}
	}
	return out
}

func (h *sessTH) lastStatus(id string) string {
	s := h.statuses(id)
	if len(s) == 0 {
		return ""
	}
	return s[len(s)-1]
}

func (h *sessTH) accepted(raw any) SubmitOK {
	h.t.Helper()
	r, err := h.s.Submit(raw)
	if err != nil {
		h.t.Fatalf("Submit(%v) refused: %v", raw, err)
	}
	return r
}

func (h *sessTH) wantStatuses(id string, want ...string) {
	h.t.Helper()
	if got := h.statuses(id); !reflect.DeepEqual(got, want) {
		h.t.Fatalf("statuses of %s = %v, want %v", id, got, want)
	}
}

func (h *sessTH) wantSent(n int, why string) {
	h.t.Helper()
	if got := h.nSent(); got != n {
		h.t.Fatalf("%d lines sent, want %d (%s): %v", got, n, why, h.sentLines())
	}
}

func sessTCode(t *testing.T, err *CmdError, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("no error, want %s", want)
	}
	if err.Code != want {
		t.Fatalf("error code = %s (%s), want %s", err.Code, err.Msg, want)
	}
}

func sessTSnap(id string) cmdTMap { return cmdTMap{"cmd": "snapshot", "id": id} }

func sessTDownload(id string) cmdTMap {
	return cmdTMap{"cmd": "download", "id": id, "snap": 1.0, "ref": "e2"}
}

func TestSession_RefusedUntilReadyAndAfterEnd(t *testing.T) {
	h := sessTMake(t)
	_, err := h.s.Submit(sessTSnap("a"))
	sessTCode(t, err, "not_session")
	if !h.s.MarkReady() {
		t.Fatal("first MarkReady is false")
	}
	if h.s.MarkReady() {
		t.Fatal("ready only counts once")
	}
	h.accepted(sessTSnap("a"))
	h.s.End()
	_, err = h.s.Submit(sessTSnap("b"))
	sessTCode(t, err, "not_session")
	h.wantSent(1, "only a")
}

func TestSession_SafeCommandsOneAtATimeInOrderCanonical(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	a := h.accepted(cmdTMap{"id": "a", "dy": 100.0, "cmd": "scroll"})
	// the answer says "accepted" even though a was sent in the same call
	if a.Status != CmdAccepted {
		t.Fatalf("status of a = %s", a.Status)
	}
	h.accepted(sessTSnap("b"))
	h.accepted(cmdTMap{"cmd": "wait", "id": "c", "ms": 5.0})
	if got, want := h.sentLines(), []string{`{"cmd":"scroll","dy":100,"id":"a"}`}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %v, want %v (only the first is in flight)", got, want)
	}
	if a.SHA256 != sha256Hex(h.sentLines()[0]) {
		t.Fatalf("returned digest %s is not the digest of the line that was sent", a.SHA256)
	}
	if !h.s.OnResult("a", true, "") {
		t.Fatal("OnResult(a) = false")
	}
	h.wantSent(2, "b after a")
	if got := h.sentLines()[1]; got != `{"cmd":"snapshot","id":"b"}` {
		t.Fatalf("second line = %s", got)
	}
	h.s.OnResult("b", true, "")
	h.s.OnResult("c", true, "")
	h.wantSent(3, "c after b")
	h.wantStatuses("a", "accepted", "sent", "done")
	h.wantStatuses("c", "accepted", "sent", "done")
}

func TestSession_FirstEventCarriesCommandLaterOnesDoNot(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(cmdTMap{"cmd": "scroll", "id": "a", "dy": 7.0})
	h.s.OnResult("a", true, "")
	ev := h.eventList()
	if len(ev) < 3 {
		t.Fatalf("events = %+v", ev)
	}
	if got := string(ev[0].Command); got != `{"cmd":"scroll","dy":7,"id":"a"}` {
		t.Fatalf("first event command = %q", got)
	}
	for i, e := range ev[1:] {
		if len(e.Command) != 0 {
			t.Fatalf("event %d carries the command again: %s", i+1, e.Command)
		}
	}
	if ev[0].Risk != RiskSafe {
		t.Fatalf("risk = %s", ev[0].Risk)
	}
	// the command in the event is the one that was hashed
	var back any
	if err := json.Unmarshal(ev[0].Command, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, map[string]any{"cmd": "scroll", "dy": 7.0, "id": "a"}) {
		t.Fatalf("command = %v", back)
	}
}

func TestSession_ResultsOnlyCountForCommandInFlight(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	h.accepted(sessTSnap("b"))
	if h.s.OnResult("b", true, "") {
		t.Fatal("b is queued, not in flight")
	}
	if h.s.OnResult("zzz", true, "") {
		t.Fatal("unknown command answered")
	}
	if !h.s.OnResult("a", false, "ref_not_found") {
		t.Fatal("a was in flight")
	}
	if h.s.OnResult("a", true, "") {
		t.Fatal("a second answer for the same command was taken")
	}
	h.wantStatuses("a", "accepted", "sent", "error")
	var errEvents []CommandEvent
	for _, e := range h.eventList() {
		if e.Status == CmdErrored {
			errEvents = append(errEvents, e)
		}
	}
	if len(errEvents) != 1 || errEvents[0].Error != "ref_not_found" {
		t.Fatalf("error events = %+v", errEvents)
	}
	h.wantSent(2, "b was sent after a finished")
}

func TestSession_ErrorWithoutCodeIsUnknown(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	h.s.OnResult("a", false, "")
	for _, e := range h.eventList() {
		if e.Status == CmdErrored && e.Error != "unknown" {
			t.Fatalf("error = %q, want unknown", e.Error)
		}
	}
	h.wantStatuses("a", "accepted", "sent", "error")
}

func TestSession_RiskyCommandWaitsForHashOfItsExactContent(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	r := h.accepted(sessTDownload("d"))
	if r.Status != CmdAwaitingApproval {
		t.Fatalf("status = %s", r.Status)
	}
	h.wantSent(0, "not approved yet")

	sessTCode(t, h.s.Approve("d", sha256Hex("something else")), "hash_mismatch")
	h.wantSent(0, "a wrong hash approves nothing")
	sessTCode(t, h.s.Approve("d", strings.ToUpper(r.SHA256)), "hash_mismatch")
	sessTCode(t, h.s.Approve("d", nil), "hash_mismatch")
	sessTCode(t, h.s.Approve("d", 5.0), "hash_mismatch")

	if err := h.s.Approve("d", r.SHA256); err != nil {
		t.Fatalf("Approve with the right hash: %v", err)
	}
	if got, want := h.sentLines(), []string{`{"cmd":"download","id":"d","ref":"e2","snap":1}`}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %v, want %v", got, want)
	}
	h.wantStatuses("d", "accepted", "awaiting_approval", "approved", "sent")
}

func TestSession_ApprovalIsOneTime(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	r := h.accepted(sessTDownload("d"))
	if err := h.s.Approve("d", r.SHA256); err != nil {
		t.Fatal(err)
	}
	sessTCode(t, h.s.Approve("d", r.SHA256), "not_waiting")
	h.s.OnResult("d", true, "")
	sessTCode(t, h.s.Approve("d", r.SHA256), "not_waiting")
	h.wantSent(1, "the guest got the command once")
}

func TestSession_ApprovalBoundToItsOwnCommand(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	a := h.accepted(sessTDownload("a"))
	b := h.accepted(cmdTMap{"cmd": "download", "id": "b", "snap": 1.0, "ref": "e9"})
	if a.SHA256 == b.SHA256 {
		t.Fatal("two different commands have the same digest")
	}
	sessTCode(t, h.s.Approve("a", b.SHA256), "hash_mismatch")
	h.wantSent(0, "cross approval")
	if err := h.s.Approve("b", b.SHA256); err != nil {
		t.Fatal(err)
	}
	h.wantSent(1, "b approved")
	if !strings.Contains(h.sentLines()[0], `"id":"b"`) {
		t.Fatalf("sent %s, want command b", h.sentLines()[0])
	}
}

func TestSession_ApproveUnknownIsNotFoundSafeIsNotWaiting(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	sessTCode(t, h.s.Approve("nope", sha256Hex("x")), "not_found")
	a := h.accepted(sessTSnap("a"))
	sessTCode(t, h.s.Approve("a", a.SHA256), "not_waiting")
}

func TestSession_ApprovedCommandGoesToEndOfQueue(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(sessTSnap("first"))
	risky := h.accepted(sessTDownload("risky"))
	h.accepted(sessTSnap("second"))
	h.accepted(sessTSnap("third"))
	if err := h.s.Approve("risky", risky.SHA256); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, id := range []string{"first", "second", "third", "risky"} {
		var line struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal([]byte(h.lastSent()), &line); err != nil {
			t.Fatal(err)
		}
		order = append(order, line.ID)
		h.s.OnResult(id, true, "")
	}
	if want := []string{"first", "second", "third", "risky"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	h.wantSent(4, "each command once")
}

func TestSession_ApprovalNotUsedInTimeExpires(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.ApprovalTTL = 40 * time.Millisecond })
	h.s.MarkReady()
	r := h.accepted(sessTDownload("d"))
	waitFor(t, "the approval to expire", func() bool { return h.lastStatus("d") == "expired" })
	h.wantStatuses("d", "accepted", "awaiting_approval", "expired")
	sessTCode(t, h.s.Approve("d", r.SHA256), "expired")
	h.wantSent(0, "an expired command is never sent")
}

func TestSession_ExpiryEnforcedAtApprovalTimeWhenTimerHasNotFired(t *testing.T) {
	var clock atomic.Int64
	clock.Store(1000)
	// The real timer must not fire during the test; a long TTL keeps
	// that true on a slow machine, and the fake clock jumps past it.
	h := sessTMake(t, func(o *SessionOptions) {
		o.ApprovalTTL = 5 * time.Second
		o.Now = clock.Load
	})
	h.s.MarkReady()
	r := h.accepted(sessTDownload("d"))
	clock.Store(1000 + 5000)
	sessTCode(t, h.s.Approve("d", r.SHA256), "expired")
	h.wantSent(0, "expired at approval time")
	if got := h.lastStatus("d"); got != "expired" {
		t.Fatalf("last status = %s", got)
	}
	// one tick before the end of the period the approval still works (control for the line above)
	h2 := sessTMake(t, func(o *SessionOptions) {
		o.ApprovalTTL = 5 * time.Second
		o.Now = clock.Load
	})
	clock.Store(1000)
	h2.s.MarkReady()
	r2 := h2.accepted(sessTDownload("d"))
	clock.Store(1000 + 4999)
	if err := h2.s.Approve("d", r2.SHA256); err != nil {
		t.Fatalf("approval one millisecond before expiry: %v", err)
	}
}

func TestSession_RejectWaitingAndQueuedNotSent(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	d := h.accepted(sessTDownload("d"))
	h.accepted(sessTSnap("a"))
	h.accepted(sessTSnap("b"))
	if err := h.s.Reject("d"); err != nil {
		t.Fatalf("waiting for approval: %v", err)
	}
	if err := h.s.Reject("b"); err != nil {
		t.Fatalf("queued, not yet sent: %v", err)
	}
	sessTCode(t, h.s.Reject("a"), "too_late") // a is in flight
	sessTCode(t, h.s.Reject("nope"), "not_found")
	if err := h.s.Approve("d", d.SHA256); err == nil {
		t.Fatal("a rejected command was approved")
	}
	h.s.OnResult("a", true, "")
	h.wantSent(1, "the rejected queued command was never sent")
	sessTCode(t, h.s.Reject("d"), "too_late")
	h.wantStatuses("b", "accepted", "rejected")
}

func TestSession_Limits(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.CommandMax = 3 })
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	_, err := h.s.Submit(sessTSnap("a"))
	sessTCode(t, err, "duplicate_id")
	_, err = h.s.Submit(cmdTMap{"cmd": "eval", "id": "x"})
	sessTCode(t, err, "bad_command")
	h.accepted(sessTSnap("b"))
	h.accepted(sessTSnap("c"))
	_, err = h.s.Submit(sessTSnap("d"))
	sessTCode(t, err, "limit")
	if n := h.s.Counts().Total; n != 3 {
		t.Fatalf("total = %d", n)
	}
}

func TestSession_NoAnswerInTimeEndsRunWithTimeout(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.CommandTimeout = 40 * time.Millisecond })
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	waitFor(t, "the run to be aborted", func() bool { return len(h.abortList()) >= 1 })
	sleep(60 * time.Millisecond) // exactly one abort, not one per tick
	ab := h.abortList()
	if len(ab) != 1 || ab[0].Reason != ReasonTimeout {
		t.Fatalf("aborts = %+v", ab)
	}
	h.wantStatuses("a", "accepted", "sent", "timeout")
	h.s.End()
	if got := h.lastStatus("a"); got != "timeout" {
		t.Fatalf("a timed-out command was voided afterwards: %s", got)
	}
}

func TestSession_AnswerInTimeCancelsCommandTimeout(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.CommandTimeout = 40 * time.Millisecond })
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	h.s.OnResult("a", true, "")
	sleep(120 * time.Millisecond) // nothing must happen: wait for several timeouts' worth
	if n := len(h.abortList()); n != 0 {
		t.Fatalf("%d aborts after an answer in time", n)
	}
}

func TestSession_WriteFailureEndsRunAsAgentError(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) {
		o.Send = func(string) error { return errors.New("socket closed") }
	})
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	ab := h.abortList()
	if len(ab) != 1 || ab[0].Reason != ReasonAgentError {
		t.Fatalf("aborts = %+v", ab)
	}
	if !strings.Contains(ab[0].Msg, "socket closed") {
		t.Fatalf("abort message %q lost the cause", ab[0].Msg)
	}
}

func TestSession_AfterCloseNothingAcceptedSentCloseIsDone(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(cmdTMap{"cmd": "close", "id": "bye"})
	_, err := h.s.Submit(sessTSnap("x"))
	sessTCode(t, err, "not_session")
	if got := h.s.Phase(); got != "closing" {
		t.Fatalf("phase = %s", got)
	}
	h.s.End()
	h.wantStatuses("bye", "accepted", "sent", "done")
}

func TestSession_CommandsBehindCloseVoidedOnEnd(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	h.accepted(cmdTMap{"cmd": "close", "id": "bye"})
	h.accepted(sessTSnap("after"))
	h.s.OnResult("a", true, "")
	if !strings.Contains(h.lastSent(), `"cmd":"close"`) {
		t.Fatalf("last sent = %s", h.lastSent())
	}
	h.s.End()
	if got := h.lastStatus("after"); got != "voided" {
		t.Fatalf("status of after = %s", got)
	}
	h.wantSent(2, "the command behind the close never reached the guest")
}

func TestSession_NothingSentAfterCloseEvenWhenAnsweredFirst(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	h.accepted(cmdTMap{"cmd": "close", "id": "bye"})
	h.accepted(sessTSnap("x")) // accepted: the close has not been sent yet
	h.s.OnResult("a", true, "")
	if !strings.Contains(h.lastSent(), `"cmd":"close"`) {
		t.Fatalf("last sent = %s", h.lastSent())
	}
	if !h.s.OnResult("bye", true, "") {
		t.Fatal("the close was in flight")
	}
	h.wantSent(2, "nothing is sent after the close, even once it has been answered")
	h.s.End()
	if got := h.lastStatus("x"); got != "voided" {
		t.Fatalf("status of x = %s", got)
	}
}

func TestSession_EndVoidsOpenCommandsAndSilencesTimers(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) {
		o.ApprovalTTL = 40 * time.Millisecond
		o.CommandTimeout = 40 * time.Millisecond
		o.Idle = 40 * time.Millisecond
	})
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	h.accepted(sessTSnap("b"))
	d := h.accepted(sessTDownload("d"))
	h.s.End()
	for _, id := range []string{"a", "b", "d"} {
		if got := h.lastStatus(id); got != "voided" {
			t.Fatalf("status of %s = %s", id, got)
		}
	}
	n := len(h.eventList())
	sleep(150 * time.Millisecond) // nothing must happen: longer than every timer set above
	if got := len(h.eventList()); got != n {
		t.Fatalf("%d events after the end, want %d: %+v", got, n, h.eventList()[n:])
	}
	if len(h.abortList()) != 0 {
		t.Fatalf("aborts = %+v", h.abortList())
	}
	sessTCode(t, h.s.Approve("d", d.SHA256), "not_session")
	if h.s.OnResult("a", true, "") {
		t.Fatal("a result was taken after the end")
	}
	h.s.End() // idempotent
	if got := len(h.eventList()); got != n {
		t.Fatalf("a second End published %d more events", got-n)
	}
}

func TestSession_EndPublishesVoidedInCreationOrder(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	for _, id := range []string{"c1", "c2", "c3", "c4", "c5", "c6"} {
		h.accepted(sessTSnap(id))
	}
	before := len(h.eventList())
	h.s.End()
	var got []string
	for _, e := range h.eventList()[before:] {
		got = append(got, e.CommandID)
	}
	if want := []string{"c1", "c2", "c3", "c4", "c5", "c6"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("voided in order %v, want %v", got, want)
	}
}

func TestSession_IdleClosesSessionItself(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.Idle = 40 * time.Millisecond })
	h.s.MarkReady()
	waitFor(t, "the idle close", func() bool { return h.nSent() >= 1 })
	if got := h.sentLines(); !reflect.DeepEqual(got, []string{`{"cmd":"close","id":"idle-close"}`}) {
		t.Fatalf("sent = %v", got)
	}
	var found *CommandEvent
	for _, e := range h.eventList() {
		if e.CommandID == "idle-close" {
			e := e
			found = &e
			break
		}
	}
	if found == nil || found.By != "supervisor" {
		t.Fatalf("first idle-close event = %+v", found)
	}
	if got := h.s.Phase(); got != "closing" {
		t.Fatalf("phase = %s", got)
	}
	h.s.End()
	if got := h.lastStatus("idle-close"); got != "done" {
		t.Fatalf("status = %s", got)
	}
}

func TestSession_IdleClockRestartsAfterEachCommandStoppedWhileInFlight(t *testing.T) {
	// 100 ms: the check 30 ms after the result needs room on a loaded machine
	h := sessTMake(t, func(o *SessionOptions) { o.Idle = 100 * time.Millisecond })
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	sleep(220 * time.Millisecond) // nothing must happen while a is in flight: longer than two idle periods
	h.wantSent(1, "no idle close while a is in flight")
	h.s.OnResult("a", true, "")
	sleep(30 * time.Millisecond)
	h.wantSent(1, "the clock restarted from the result")
	waitFor(t, "the idle close after the result", func() bool { return h.nSent() == 2 })
}

func TestSession_WaitingForHumanIsNotIdleTime(t *testing.T) {
	// the approval period is 300 ms instead of 150 ms, so that the check in the middle has room
	h := sessTMake(t, func(o *SessionOptions) {
		o.Idle = 40 * time.Millisecond
		o.ApprovalTTL = 300 * time.Millisecond
	})
	h.s.MarkReady()
	h.accepted(sessTDownload("d"))
	sleep(180 * time.Millisecond) // more than four idle periods, still inside the approval period
	h.wantSent(0, "still waiting for the human, no idle close")
	waitFor(t, "the approval to expire and the idle close to follow", func() bool { return h.nSent() == 1 })
	if got := h.lastStatus("d"); got != "expired" {
		t.Fatalf("status of d = %s", got)
	}
	if !strings.Contains(h.sentLines()[0], "idle-close") {
		t.Fatalf("sent = %v", h.sentLines())
	}
}

func TestSession_RejectingOnlyWaitingCommandRestartsIdleClock(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.Idle = 40 * time.Millisecond })
	h.s.MarkReady()
	h.accepted(sessTDownload("d"))
	if err := h.s.Reject("d"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the idle close", func() bool { return h.nSent() >= 1 })
	sleep(80 * time.Millisecond) // and only one
	h.wantSent(1, "one idle close")
}

func TestSession_InternalCloseTakesFreeIDWhenUsualOneIsTaken(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.Idle = 40 * time.Millisecond })
	h.s.MarkReady()
	h.accepted(sessTSnap("idle-close"))
	h.s.OnResult("idle-close", true, "")
	waitFor(t, "the idle close", func() bool { return h.nSent() >= 2 })
	if got := h.lastSent(); got != `{"cmd":"close","id":"idle-close_"}` {
		t.Fatalf("last sent = %s", got)
	}
}

func TestSession_CountsReportTotalsAndWaitingApprovals(t *testing.T) {
	h := sessTMake(t)
	h.s.MarkReady()
	h.accepted(sessTSnap("a"))
	h.accepted(sessTDownload("d1"))
	h.accepted(sessTDownload("d2"))
	if got, want := h.s.Counts(), (CommandCounts{Total: 3, AwaitingApproval: 2}); got != want {
		t.Fatalf("counts = %+v, want %+v", got, want)
	}
	h.s.Reject("d1")
	if got, want := h.s.Counts(), (CommandCounts{Total: 3, AwaitingApproval: 1}); got != want {
		t.Fatalf("counts = %+v, want %+v", got, want)
	}
}

// Go only: the session is called from HTTP handlers and timer goroutines at once; this is for the race detector and
// for the invariant that one command is in flight at a time.
func TestSession_ConcurrentSubmitAndResultsAreSafe(t *testing.T) {
	h := sessTMake(t, func(o *SessionOptions) { o.CommandMax = 100 })
	h.s.MarkReady()
	const workers, each = 8, 10
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				if _, err := h.s.Submit(sessTSnap(fmt.Sprintf("w%d-%d", w, i))); err != nil {
					t.Errorf("Submit: %v", err)
				}
				h.s.Counts()
			}
		}()
	}
	// answer whatever is in flight until everything has been sent and answered
	answered := 0
	end := time.Now().Add(5 * time.Second)
	for answered < workers*each && time.Now().Before(end) {
		sent := h.sentLines()
		if len(sent) > answered {
			var line struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal([]byte(sent[answered]), &line); err != nil {
				t.Fatal(err)
			}
			if len(sent) != answered+1 {
				t.Fatalf("%d lines sent with %d answered: more than one in flight", len(sent), answered)
			}
			if !h.s.OnResult(line.ID, true, "") {
				t.Fatalf("OnResult(%s) = false", line.ID)
			}
			answered++
			continue
		}
		sleep(time.Millisecond)
	}
	wg.Wait()
	if answered != workers*each {
		t.Fatalf("answered %d of %d", answered, workers*each)
	}
	if n := h.s.Counts().Total; n != workers*each {
		t.Fatalf("total = %d", n)
	}
}

// Go only: an idle timer that has fired but is still waiting for the lock must not close a session that has started
// a command in the meantime (the generation counter). Emit holds the session lock for the first command, long enough
// for the idle timer to fire and queue up behind it.
func TestSession_StaleIdleTimerDoesNotCloseBusySession(t *testing.T) {
	entered := make(chan struct{})
	var once sync.Once
	h := sessTMake(t, func(o *SessionOptions) {
		o.Idle = 50 * time.Millisecond
		orig := o.Emit
		o.Emit = func(ev CommandEvent) {
			once.Do(func() {
				close(entered)
				sleep(200 * time.Millisecond)
			})
			orig(ev)
		}
	})
	h.s.MarkReady()
	done := make(chan error, 1)
	go func() {
		_, err := h.s.Submit(sessTSnap("a"))
		if err != nil {
			done <- err
			return
		}
		done <- nil
	}()
	<-entered
	if err := <-done; err != nil {
		t.Fatalf("Submit: %v", err)
	}
	sleep(150 * time.Millisecond) // nothing must happen: a is in flight and no idle period can have run
	h.wantSent(1, "a only; the stale idle timer must not send a close")
	h.wantStatuses("a", "accepted", "sent")
	if got := h.statuses("idle-close"); len(got) != 0 {
		t.Fatalf("the stale idle timer queued a close: %v", got)
	}
}
