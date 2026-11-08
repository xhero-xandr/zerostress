package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func coreTIntPtr(i int) *int { return &i }

// coreTRun submits a plain run and waits for its end.
func coreTRun(t *testing.T, h *Harness, path string) (string, RunView) {
	t.Helper()
	id := h.submit(t, path)
	return id, h.finished(t, id)
}

func coreTReason(v RunView) string {
	if v.Reason == nil {
		return ""
	}
	return string(*v.Reason)
}

func coreTAgent(v RunView) string {
	if v.AgentStatus == nil {
		return ""
	}
	return *v.AgentStatus
}

func TestCore_SlotPoolHandsOutLowestFreeSlotAndReportsExhaustion(t *testing.T) {
	p := NewSlotPool(3)
	got := []int{p.Acquire(), p.Acquire(), p.Acquire(), p.Acquire()}
	if !reflect.DeepEqual(got, []int{0, 1, 2, -1}) {
		t.Fatalf("acquired %v", got)
	}
	p.Release(1)
	if n := p.Acquire(); n != 1 {
		t.Fatalf("after release got %d", n)
	}
	if p.InUse() != 3 {
		t.Fatalf("in use = %d", p.InUse())
	}
}

func TestCore_SuccessfulRunStatesEvidenceAndCleanup(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"e":1}`, `{"e":2}`, okStatus}}}, nil)
	h.start(t)
	id, v := coreTRun(t, h, "/ok")
	if v.State != StateDone || coreTAgent(v) != "ok" || v.Partial {
		t.Fatalf("view = %+v", v)
	}
	want := []string{"queued", "preparing", "booting", "running", "destroying", "done"}
	if got := dedupe(h.states(id)); !reflect.DeepEqual(got, want) {
		t.Fatalf("states = %v, want %v", got, want)
	}
	if got := h.evidence(id); !reflect.DeepEqual(got, []string{`{"e":1}`, `{"e":2}`}) {
		t.Fatalf("evidence = %v", got)
	}
	statusEvents := 0
	for i, e := range h.events(id) {
		if e.Type == "status" {
			statusEvents++
		}
		if e.Seq != i+1 {
			t.Fatalf("event %d has seq %d", i, e.Seq)
		}
	}
	if statusEvents != 1 {
		t.Fatalf("%d status events", statusEvents)
	}
	var job struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(h.Backend.LastJob()), &job); err != nil || !strings.HasPrefix(job.URL, "https://example.test") {
		t.Fatalf("job = %q (%v)", h.Backend.LastJob(), err)
	}
	h.idle(t)
}

func TestCore_EachSetupFailureMapsToItsReasonAndCleansUp(t *testing.T) {
	cases := []struct {
		path   string
		script Script
		reason string
	}{
		{"/disk", Script{PrepareDiskFail: true}, "disk_copy"},
		{"/net", Script{NetUpFail: true}, "net_setup"},
		{"/fcapi", Script{StartFail: true}, "fc_api"},
		{"/boot", Script{Ready: "timeout"}, "boot_timeout"},
		{"/crashboot", Script{Ready: "crash"}, "fc_crashed"},
	}
	scripts := map[string]Script{}
	for _, c := range cases {
		scripts[c.path] = c.script
	}
	h := newHarness(t, scripts, nil)
	h.start(t)
	for _, c := range cases {
		_, v := coreTRun(t, h, c.path)
		if v.State != StateFailed || coreTReason(v) != c.reason {
			t.Fatalf("%s: state %s reason %q, want failed/%s", c.path, v.State, coreTReason(v), c.reason)
		}
		if v.Partial {
			t.Fatalf("%s: a run without evidence is marked partial", c.path)
		}
		h.idle(t)
	}
}

func TestCore_AgentStatusesMapToReasonsAndEvidenceBeforeFailureIsPartial(t *testing.T) {
	cases := []struct{ path, agent, reason string }{
		{"/timeout", "timeout", "timeout"},
		{"/oversize", "oversize", "oversize"},
		{"/nonzero", "exited_nonzero", "collector_failed"},
		{"/nostart", "start_failed", "collector_failed"},
		{"/busy", "busy", "agent_error"},
		{"/badjob", "bad_job", "agent_error"},
	}
	scripts := map[string]Script{}
	for _, c := range cases {
		scripts[c.path] = Script{Lines: []string{`{"seen":1}`, statusLine(c.agent)}}
	}
	h := newHarness(t, scripts, nil)
	h.start(t)
	for _, c := range cases {
		_, v := coreTRun(t, h, c.path)
		if v.State != StateFailed || coreTReason(v) != c.reason || coreTAgent(v) != c.agent || !v.Partial {
			t.Fatalf("%s: state %s reason %q agent %q partial %v", c.path, v.State, coreTReason(v), coreTAgent(v), v.Partial)
		}
	}
	h.idle(t)
}

func TestCore_StreamWithoutStatusIsAgentErrorOrFcCrashedIfVMDied(t *testing.T) {
	h := newHarness(t, map[string]Script{
		"/nostatus":  {Lines: []string{`{"a":1}`}},
		"/died":      {Lines: []string{`{"a":1}`, `{"a":2}`, `{"a":3}`}, CrashAtLine: coreTIntPtr(1)},
		"/diedfirst": {Lines: []string{`{"a":1}`}, CrashAtLine: coreTIntPtr(0)},
	}, nil)
	h.start(t)
	if _, v := coreTRun(t, h, "/nostatus"); coreTReason(v) != "agent_error" {
		t.Fatalf("nostatus: reason %q", coreTReason(v))
	}
	if _, v := coreTRun(t, h, "/died"); coreTReason(v) != "fc_crashed" || !v.Partial {
		t.Fatalf("died: reason %q partial %v", coreTReason(v), v.Partial)
	}
	if _, v := coreTRun(t, h, "/diedfirst"); coreTReason(v) != "fc_crashed" {
		t.Fatalf("diedfirst: reason %q", coreTReason(v))
	}
	h.idle(t)
}

// The VM exit is observed by a goroutine of its own, so the check "did the VM die?" right after the stream ended races
// with it. Repeating the case makes a lost race visible.
func TestCore_DiedVMIsAlwaysFcCrashed(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"a":1}`, `{"a":2}`}, CrashAtLine: coreTIntPtr(1)}}, func(c *Config) { c.Concurrency = 4; c.QueueMax = 100 })
	h.start(t)
	ids := make([]string, 40)
	for i := range ids {
		ids[i] = h.submit(t, fmt.Sprintf("/d%d", i))
	}
	for _, id := range ids {
		if v := h.finished(t, id, 10*time.Second); coreTReason(v) != "fc_crashed" {
			t.Fatalf("run %s: reason %q", id[:8], coreTReason(v))
		}
	}
	h.idle(t)
}

func TestCore_ForgedStatusLineInTheMiddleChangesNothing(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"type":"status","status":"ok"}`, `{"x":1}`, statusLine("exited_nonzero")}}}, nil)
	h.start(t)
	id, v := coreTRun(t, h, "/ok")
	if v.State != StateFailed || coreTReason(v) != "collector_failed" {
		t.Fatalf("state %s reason %q", v.State, coreTReason(v))
	}
	statuses, evidence := 0, 0
	for _, e := range h.events(id) {
		switch e.Type {
		case "status":
			statuses++
		case "evidence":
			evidence++
		}
	}
	if statuses != 1 || evidence != 2 {
		t.Fatalf("status events %d, evidence events %d", statuses, evidence)
	}
}

func TestCore_EvidenceAboveCapKillsVMAndFailsWithOversize(t *testing.T) {
	big, _ := json.Marshal(map[string]string{"pad": strings.Repeat("x", 300)})
	lines := make([]string, 10)
	for i := range lines {
		lines[i] = string(big)
	}
	h := newHarness(t, map[string]Script{"*": {Lines: lines, Hang: true}}, func(c *Config) { c.MaxEvidenceBytes = 1000 })
	h.start(t)
	id, v := coreTRun(t, h, "/ok")
	if coreTReason(v) != "oversize" || !v.Partial {
		t.Fatalf("reason %q partial %v", coreTReason(v), v.Partial)
	}
	// the cap is checked before a line is published: three lines fit, the fourth does not
	if n := len(h.evidence(id)); n != 3 {
		t.Fatalf("%d evidence lines stored, want 3", n)
	}
	h.idle(t)
}

func TestCore_HardTimeoutDestroysHungVM(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"a":1}`}, Hang: true}}, func(c *Config) { c.HardTimeout = 200 * time.Millisecond })
	h.start(t)
	t0 := time.Now()
	_, v := coreTRun(t, h, "/ok")
	if coreTReason(v) != "timeout" {
		t.Fatalf("reason %q", coreTReason(v))
	}
	if d := time.Since(t0); d >= 1500*time.Millisecond {
		t.Fatalf("took %v", d)
	}
	h.idle(t)
}

func TestCore_CancelRunningQueuedFinishedAndUnknownRuns(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) { c.Concurrency = 1; c.HardTimeout = 5 * time.Second })
	h.start(t)
	a := h.submit(t, "/a")
	b := h.submit(t, "/b")
	h.waitState(t, a, StateRunning)
	if h.state(b) != StateQueued {
		t.Fatalf("b is %s", h.state(b))
	}
	if got := h.Sup.Cancel(b); got != "cancelled" {
		t.Fatalf("cancel b = %s", got)
	}
	if v, _ := h.Sup.Get(b); coreTReason(v) != "cancelled" {
		t.Fatalf("b reason %q", coreTReason(v))
	}
	if got := h.Sup.Cancel(a); got != "cancelling" {
		t.Fatalf("cancel a = %s", got)
	}
	if v := h.finished(t, a); coreTReason(v) != "cancelled" {
		t.Fatalf("a reason %q", coreTReason(v))
	}
	if got := h.Sup.Cancel(a); got != "conflict" {
		t.Fatalf("second cancel a = %s", got)
	}
	if got := h.Sup.Cancel("00000000-0000-4000-8000-000000000000"); got != "not_found" {
		t.Fatalf("cancel unknown = %s", got)
	}
	h.idle(t)
}

func TestCore_ConcurrencyHonouredOrderFIFOSlotsNeverCollide(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"a":1}`, okStatus}, LineDelay: 40 * time.Millisecond}}, func(c *Config) { c.Concurrency = 2 })
	h.start(t)
	ids := make([]string, 6)
	for i := range ids {
		ids[i] = h.submit(t, fmt.Sprintf("/r%d", i))
	}
	for _, id := range ids {
		h.finished(t, id)
	}
	if n := h.Backend.MaxVMs(); n != 2 {
		t.Fatalf("max VMs = %d", n)
	}
	// Runs are dispatched in submission order, but two runs dispatched together call Start from two goroutines, so
	// the order of those calls may be swapped: a run may move by at most concurrency-1 places.
	started := h.Backend.Started()
	if len(started) != len(ids) {
		t.Fatalf("started %v", started)
	}
	pos := map[string]int{}
	for i, id := range started {
		pos[id] = i
	}
	for i, id := range ids {
		p, ok := pos[id]
		if !ok || p < i-1 || p > i+1 {
			t.Fatalf("run %d started at position %d (order %v)", i, p, started)
		}
	}
	for _, id := range ids {
		if h.state(id) != StateDone {
			t.Fatalf("run %s is %s", id[:8], h.state(id))
		}
	}
	h.idle(t) // NetUp fails if a slot was handed out twice, so reaching here proves it
}

func TestCore_QueueLimitDiskGuardAndQueueTimeout(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.Concurrency = 1
		c.QueueMax = 2
		c.QueueWait = 150 * time.Millisecond
		c.HardTimeout = 3 * time.Second
	})
	h.start(t)
	first := h.submit(t, "/1") // takes the slot
	q1, err := h.Sup.Submit(urlOf("/2"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if q1.Position == nil || *q1.Position != 1 {
		t.Fatalf("position = %v", q1.Position)
	}
	if _, err := h.Sup.Submit(urlOf("/3"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Sup.Submit(urlOf("/4"), nil); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("fourth submit: %v", err)
	}
	h.waitState(t, q1.RunID, StateFailed)
	if v, _ := h.Sup.Get(q1.RunID); coreTReason(v) != "queue_timeout" {
		t.Fatalf("reason %q", coreTReason(v))
	}
	h.Sup.Cancel(first)
	h.finished(t, first)
	h.idle(t)

	low := newHarness(t, map[string]Script{}, func(c *Config) { c.MinFreeGB = 20 }, func(d *Deps) { d.FreeGB = func() float64 { return 5 } })
	low.start(t)
	if _, err := low.Sup.Submit(urlOf("/x"), nil); !errors.Is(err, ErrLowDisk) {
		t.Fatalf("low disk submit: %v", err)
	}
}

func TestCore_RecoveryInFlightFailQueuedContinueExpiredRemoved(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{okStatus}}}, nil)
	const inflightID = "11111111-1111-4111-8111-111111111111"
	const waitingID = "22222222-2222-4222-8222-222222222222"
	const oldID = "33333333-3333-4333-8333-333333333333"
	now := time.Now().UnixMilli()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(h.Store.Insert(RunRecord{ID: inflightID, URL: urlOf("/inflight"), CreatedAt: now - 1000, ExpiresAt: now + 100000}))
	must(h.Store.Update(inflightID, func(r *RunRecord) {
		r.State = StateRunning
		r.Slot = ptr(0)
		r.StartedAt = ptr(now - 900)
	}))
	must(h.Store.Insert(RunRecord{ID: waitingID, URL: urlOf("/waiting"), CreatedAt: now - 500, ExpiresAt: now + 100000}))
	must(h.Store.Insert(RunRecord{ID: oldID, URL: urlOf("/old"), CreatedAt: now - 99999, ExpiresAt: now - 1}))
	must(h.Store.Update(oldID, func(r *RunRecord) { r.State = StateDone }))
	h.start(t)
	if n := h.Backend.Recovered(); n != 1 {
		t.Fatalf("recovered = %d", n)
	}
	inflight, ok := h.Sup.Get(inflightID)
	if !ok || inflight.State != StateFailed || coreTReason(inflight) != "supervisor_restart" {
		t.Fatalf("in-flight run: %+v", inflight)
	}
	if v := h.finished(t, waitingID); v.State != StateDone {
		t.Fatalf("queued run ended %s", v.State)
	}
	if _, ok := h.Sup.Get(oldID); ok {
		t.Fatal("expired run is still there")
	}
	h.idle(t)
}

func TestCore_ShutdownForcesRunningDownQueuedStayQueued(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.Concurrency = 1
		c.HardTimeout = 5 * time.Second
		c.ShutdownGrace = 100 * time.Millisecond
	})
	h.start(t)
	a := h.submit(t, "/a")
	b := h.submit(t, "/b")
	h.waitState(t, a, StateRunning)
	h.Sup.Shutdown()
	if v, _ := h.Sup.Get(a); coreTReason(v) != "supervisor_restart" {
		t.Fatalf("a reason %q", coreTReason(v))
	}
	if rec, _ := h.Store.Get(b); rec.State != StateQueued {
		t.Fatalf("b is %s", rec.State)
	}
	if _, err := h.Sup.Submit(urlOf("/c"), nil); !errors.Is(err, ErrDraining) {
		t.Fatalf("submit while draining: %v", err)
	}
	h.Backend.AssertClean(t)
}

func TestCore_EventsReplayAfterSeqLiveDeliveryUnknownRun(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"a":1}`, `{"a":2}`, okStatus}, LineDelay: 30 * time.Millisecond}}, nil)
	h.start(t)
	id := h.submit(t, "/s")
	sub, ok := h.Sup.Subscribe(id, 0)
	if !ok {
		t.Fatal("no subscription")
	}
	var mu sync.Mutex
	var live []int
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range sub.Events {
			mu.Lock()
			live = append(live, ev.Seq)
			mu.Unlock()
		}
	}()
	h.finished(t, id)
	all := h.events(id)
	waitFor(t, "live events", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(sub.Replay)+len(live) >= len(all)
	})
	sub.Close()
	<-done
	var got, want []int
	for _, e := range sub.Replay {
		got = append(got, e.Seq)
	}
	mu.Lock()
	got = append(got, live...)
	mu.Unlock()
	for _, e := range all {
		want = append(want, e.Seq)
	}
	// replay followed by live, in order, each event once
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("replay + live = %v, want %v", got, want)
	}

	later, ok := h.Sup.Subscribe(id, 3)
	if !ok {
		t.Fatal("no second subscription")
	}
	defer later.Close()
	var laterSeqs, wantLater []int
	for _, e := range later.Replay {
		laterSeqs = append(laterSeqs, e.Seq)
	}
	for _, e := range all {
		if e.Seq > 3 {
			wantLater = append(wantLater, e.Seq)
		}
	}
	if !reflect.DeepEqual(laterSeqs, wantLater) || len(wantLater) == 0 {
		t.Fatalf("replay after 3 = %v, want %v", laterSeqs, wantLater)
	}
	if _, ok := h.Sup.Subscribe("44444444-4444-4444-8444-444444444444", 0); ok {
		t.Fatal("subscribed to an unknown run")
	}
}

// A reader that does not read is cut off when its buffer is full, and gets the rest from the stored events on reconnect.
func TestCore_SlowSubscriberIsDroppedAndCanResume(t *testing.T) {
	lines := make([]string, 0, 5001)
	for i := 0; i < 5000; i++ {
		lines = append(lines, fmt.Sprintf(`{"n":%d}`, i))
	}
	lines = append(lines, okStatus)
	h := newHarness(t, map[string]Script{"*": {Lines: lines}}, nil)
	h.start(t)
	id := h.submit(t, "/many")
	sub, ok := h.Sup.Subscribe(id, 0)
	if !ok {
		t.Fatal("no subscription")
	}
	h.finished(t, id, 10*time.Second)
	if !sub.Dropped() {
		t.Fatal("a subscriber that never reads was not dropped")
	}
	last := 0
	if len(sub.Replay) > 0 {
		last = sub.Replay[len(sub.Replay)-1].Seq
	}
	n := 0
	for ev := range sub.Events { // closed by the drop: the buffered events can still be read
		if ev.Seq != last+1 {
			t.Fatalf("gap in buffered events: %d after %d", ev.Seq, last)
		}
		last = ev.Seq
		n++
	}
	if n == 0 || n >= len(h.events(id)) {
		t.Fatalf("buffered %d of %d events", n, len(h.events(id)))
	}
	rest, ok := h.Sup.Subscribe(id, last)
	if !ok {
		t.Fatal("no resume subscription")
	}
	defer rest.Close()
	all := h.events(id)
	if len(rest.Replay) == 0 || rest.Replay[len(rest.Replay)-1].Seq != all[len(all)-1].Seq || rest.Replay[0].Seq != last+1 {
		t.Fatalf("resume replay starts at %d, ends at %d; last seen %d", rest.Replay[0].Seq, rest.Replay[len(rest.Replay)-1].Seq, last)
	}
}

func TestCore_LogsNeverContainTheFullURL(t *testing.T) {
	h := newHarness(t, map[string]Script{"/fail": {Lines: []string{statusLine("exited_nonzero")}}}, nil)
	h.start(t)
	res, err := h.Sup.Submit("https://example.test/fail?token=SECRET-TOKEN-123#frag", nil)
	if err != nil {
		t.Fatal(err)
	}
	h.finished(t, res.RunID)
	logs := h.Logs()
	if len(logs) == 0 {
		t.Fatal("nothing was logged")
	}
	sawHost := false
	for _, l := range logs {
		if strings.Contains(l, "SECRET-TOKEN-123") {
			t.Fatalf("token in log: %s", l)
		}
		if strings.Contains(l, "example.test") {
			sawHost = true
		}
	}
	if !sawHost {
		t.Fatalf("host not logged: %v", logs)
	}
}

// The Read returns nothing and Append returns an error.
func TestCore_RunIDsAreValidatedBeforeTheyReachAPath(t *testing.T) {
	h := newHarness(t, map[string]Script{}, nil)
	if got := h.Results.Read("../../etc/passwd", 0); got != nil {
		t.Fatalf("read of a bad id returned %v", got)
	}
	if err := h.Results.Append("x/../y", RunEvent{Seq: 1, Type: "state", Data: "{}"}); err == nil {
		t.Fatal("append with a bad id succeeded")
	}
}

func TestCore_TwentyRunsInARowLeaveNothingBehind(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"a":1}`, okStatus}}}, func(c *Config) { c.Concurrency = 3 })
	h.start(t)
	ids := make([]string, 20)
	for i := range ids {
		ids[i] = h.submit(t, fmt.Sprintf("/n%d", i))
	}
	for _, id := range ids {
		h.finished(t, id, 8*time.Second)
	}
	h.idle(t)
	if q := h.Sup.Health().Queued; q != 0 {
		t.Fatalf("queued = %d", q)
	}
	sleep(20 * time.Millisecond)
}

// With the periodic sweep out of the picture, a run that has waited too long is still refused when its turn comes.
func TestCore_QueueTimeoutIsAlsoCheckedAtDispatch(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.Concurrency = 1
		c.QueueWait = 100 * time.Millisecond
		c.HardTimeout = 3 * time.Second
	}, func(d *Deps) { d.SweepEvery = time.Hour })
	h.start(t)
	first := h.submit(t, "/1")
	second := h.submit(t, "/2")
	h.waitState(t, first, StateRunning)
	sleep(250 * time.Millisecond) // the queued run must be older than the queue wait when the slot frees up
	if h.state(second) != StateQueued {
		t.Fatalf("second is %s", h.state(second))
	}
	h.Sup.Cancel(first)
	v := h.finished(t, second)
	if v.State != StateFailed || coreTReason(v) != "queue_timeout" {
		t.Fatalf("second: %s %q", v.State, coreTReason(v))
	}
	if got := h.Backend.Started(); len(got) != 1 || got[0] != first {
		t.Fatalf("started %v: the expired run must not get a VM", got)
	}
	h.finished(t, first)
	h.idle(t)
}

// The periodic sweep, not the dispatch, fails a waiting run while every slot is busy.
func TestCore_QueueTimeoutSweepFailsWaitingRunWhileSlotIsBusy(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.Concurrency = 1
		c.QueueWait = 100 * time.Millisecond
		c.HardTimeout = 5 * time.Second
	})
	h.start(t)
	first := h.submit(t, "/1")
	second := h.submit(t, "/2")
	h.waitState(t, first, StateRunning)
	h.waitState(t, second, StateFailed, time.Second)
	if v, _ := h.Sup.Get(second); coreTReason(v) != "queue_timeout" {
		t.Fatalf("reason %q", coreTReason(v))
	}
	if h.state(first) != StateRunning {
		t.Fatalf("first is %s", h.state(first))
	}
	if q := h.Sup.Health().Queued; q != 0 {
		t.Fatalf("queued = %d", q)
	}
	h.Sup.Cancel(first)
	h.finished(t, first)
	h.idle(t)
}

// While the service shuts down, a VM that goes away is the shutdown's doing (or systemd's), not a crash.
func TestCore_VMDyingWhileShuttingDownIsRestartNotCrash(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.HardTimeout = 5 * time.Second
		c.ShutdownGrace = 2 * time.Second
	})
	h.start(t)
	id := h.submit(t, "/a")
	h.waitState(t, id, StateRunning)
	done := make(chan struct{})
	go func() { h.Sup.Shutdown(); close(done) }()
	waitFor(t, "draining", func() bool { return h.Sup.draining.Load() })
	h.Backend.VM(id).kill()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish")
	}
	if v, _ := h.Sup.Get(id); coreTReason(v) != "supervisor_restart" {
		t.Fatalf("reason %q", coreTReason(v))
	}
	h.Backend.AssertClean(t)
}

// A VM whose unit does not end when stopped keeps its slot: the next run waits in the queue (every VM of a slot runs
// as the slot's user), health says so, and the slot comes back once the unit is gone (review E).
func TestCore_AVMThatDoesNotEndKeepsItsSlot(t *testing.T) {
	stuck := &atomic.Bool{}
	stuck.Store(true)
	h := newHarness(t, map[string]Script{"/a": {Stuck: stuck}, "*": {}}, func(c *Config) { c.Concurrency = 1 })
	h.start(t)
	a := h.submit(t, "/a")
	h.finished(t, a)
	b := h.submit(t, "/b")
	time.Sleep(300 * time.Millisecond) // many sweeps (20 ms each): the slot must stay held
	if st := h.state(b); st != StateQueued {
		t.Fatalf("b is %s while a's VM is still there", st)
	}
	if hl := h.Sup.Health(); hl.OK || hl.Quarantined != 1 {
		t.Fatalf("health with the only slot held: ok=%v quarantined=%d", hl.OK, hl.Quarantined)
	}
	stuck.Store(false)
	h.finished(t, b)
	if hl := h.Sup.Health(); !hl.OK || hl.Quarantined != 0 {
		t.Fatalf("health after the VM is gone: ok=%v quarantined=%d", hl.OK, hl.Quarantined)
	}
	if !slices.ContainsFunc(h.Logs(), func(l string) bool { return strings.Contains(l, "slot is held") }) {
		t.Fatal("holding the slot was not logged")
	}
	h.idle(t)
}
