package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---- one run -----------------------------------------------------------------------------------------------

type vmBox struct{ vm VM }

type outcome struct {
	state       RunState
	reason      FailReason
	agentStatus string
}

// runExec is the state of one run from the moment it gets a slot until its resources are released. The fields that
// steps() and teardown() use are touched only by the run's own goroutine; the ones read from the stream callback,
// the VM-exit watcher and the artifact fetches are atomics or guarded by artMu.
type runExec struct {
	s      *Supervisor
	rec    RunRecord
	id     string
	slot   int
	runDir string
	cancel context.CancelCauseFunc

	vm         VM
	netTouched bool
	destroying atomic.Bool
	vmDead     atomic.Bool
	// vmForCommands is set once the guest is ready; until then commands and artifact fetches have nowhere to go.
	vmForCommands atomic.Pointer[vmBox]
	hard          *time.Timer
	sess          *SessionCommands

	// the stream: a line that may be the agent's final status is held back until the next line arrives
	held          *string
	evidence      int
	evidenceBytes int
	out           outcome

	fetches  sync.WaitGroup
	artMu    sync.Mutex
	artSeen  map[string]bool
	artFiles int
	artBytes int64
}

// execute never fails: every outcome ends in a terminal state, and resources are released in teardown.
func (s *Supervisor) execute(ctx context.Context, rec RunRecord, slot int, cancel context.CancelCauseFunc, a *activeRun) {
	defer close(a.done)
	r := &runExec{
		s: s, rec: rec, id: rec.ID, slot: slot, runDir: filepath.Join(s.cfg.RunsDir, rec.ID), cancel: cancel,
		out:     outcome{state: StateFailed, reason: ReasonInternal},
		artSeen: map[string]bool{},
	}
	r.startTimers()
	r.startSession()
	if err := r.steps(ctx); err != nil {
		r.recordFailure(ctx, err)
	}
	r.teardown()
}

// startTimers sets the supervisor's own ceiling. A session lives for its own time, and the ceiling does not depend on
// the collector.
func (r *runExec) startTimers() {
	hardFor := r.s.cfg.HardTimeout
	if r.rec.Session != nil {
		hardFor = r.s.cfg.BootTimeout + time.Duration(r.rec.Session.MaxMs)*time.Millisecond + r.s.cfg.SessionGrace
	}
	r.hard = time.AfterFunc(hardFor, func() { r.cancel(newRunError(ReasonTimeout, "hard timeout")) })
}

func (r *runExec) startSession() {
	if r.rec.Session == nil {
		return
	}
	s, id := r.s, r.id
	r.sess = NewSessionCommands(SessionOptions{
		Idle:           time.Duration(r.rec.Session.IdleMs) * time.Millisecond,
		CommandMax:     s.cfg.CommandMax,
		CommandTimeout: s.cfg.CommandTimeout,
		ApprovalTTL:    s.cfg.ApprovalTTL,
		Now:            s.now,
		Send: func(line string) error {
			b := r.vmForCommands.Load()
			if b == nil {
				return errors.New("no VM")
			}
			return b.vm.Send(line)
		},
		Emit: func(ev CommandEvent) {
			// the log gets ids, type, status and hash, never parameters (they may carry typed-in values)
			s.log("info", "command", map[string]any{"run_id": id, "command_id": ev.CommandID, "cmd": ev.Cmd, "status": ev.Status, "command_sha256": ev.SHA256})
			s.emit(id, "command", toJSON(ev))
		},
		Abort: func(e *RunError) { r.cancel(e) },
	})
	s.mu.Lock()
	s.sessions[id] = r.sess
	s.mu.Unlock()
}

// failed turns an error from a step into the run's failure: the cause of an aborted run beats the step's own error.
func (r *runExec) failed(ctx context.Context, err error, fallback FailReason) error {
	if ctx.Err() != nil {
		return causeOf(ctx, ReasonInternal)
	}
	return asRunError(err, fallback)
}

// steps runs the VM from disk copy to the agent's final status. On success it sets r.out; an error is the run's failure.
func (r *runExec) steps(ctx context.Context) error {
	s, id := r.s, r.id
	s.setState(id, StatePreparing, func(rec *RunRecord) {
		rec.Slot = &r.slot
		rec.StartedAt = ptr(s.now())
	})
	if err := s.backend.PrepareDisk(ctx, r.runDir); err != nil {
		return r.failed(ctx, err, ReasonDiskCopy)
	}
	r.netTouched = true
	if err := s.backend.NetUp(ctx, r.slot, id); err != nil {
		return r.failed(ctx, err, ReasonNetSetup)
	}
	s.setState(id, StateBooting, nil)
	v, err := s.backend.Start(ctx, StartOptions{RunID: id, RunDir: r.runDir, Slot: r.slot, VCPU: s.cfg.VCPU, MemMiB: s.cfg.MemMiB})
	if err != nil {
		return r.failed(ctx, err, ReasonFcAPI)
	}
	r.vm = v
	exitHandled := r.watchExit(v)
	if err := v.WaitReady(ctx, s.cfg.BootTimeout); err != nil {
		return r.failed(ctx, err, ReasonBootTimeout)
	}
	r.vmForCommands.Store(&vmBox{vm: v})

	s.setState(id, StateRunning, nil)
	// The guest gets only the total time. Idle time belongs to the supervisor (it alone knows when a human is
	// deciding about a risky command), which sends a normal close when the session has been idle for too long.
	if err := v.RunJob(ctx, jobLine(id, r.rec), func(line string) { r.onLine(ctx, line) }); err != nil {
		return r.failed(ctx, err, ReasonAgentError)
	}
	if ctx.Err() != nil {
		return causeOf(ctx, ReasonInternal)
	}
	return r.finishStream(ctx, exitHandled)
}

// watchExit returns a channel closed once the exit of the VM has been fully accounted for (flag set, run cancelled if
// that was not our own doing). Waiting on Exited() alone would race with this goroutine.
func (r *runExec) watchExit(v VM) <-chan struct{} {
	exitHandled := make(chan struct{})
	go func() {
		defer close(exitHandled)
		<-v.Exited()
		r.vmDead.Store(true)
		// while we are shutting down, a dying VM is our own doing (or systemd's), not a crash
		if !r.destroying.Load() {
			if r.s.draining.Load() {
				r.cancel(newRunError(ReasonSupervisorRestart, ""))
			} else {
				r.cancel(newRunError(ReasonFcCrashed, "firecracker exited"))
			}
		}
	}()
	return exitHandled
}

// onLine is called for every line of the stream, in order.
func (r *runExec) onLine(ctx context.Context, line string) {
	r.evidenceBytes += len(line) + 1
	if r.evidenceBytes > r.s.cfg.MaxEvidenceBytes {
		r.cancel(newRunError(ReasonOversize, "evidence cap exceeded"))
		return
	}
	r.flushHeld()
	// Only a line that looks like a status line is held back, until the next line shows whether it was the
	// last one. Everything else is published at once, so a session's evidence is live, not one line late.
	if len(line) <= statusLineMax && parseStatus(line) != "" {
		l := line
		r.held = &l
		return
	}
	r.s.emit(r.id, "evidence", line)
	r.evidence++
	r.onControlLine(line)
	r.onArtifactLine(ctx, line)
}

func (r *runExec) flushHeld() {
	if r.held != nil {
		r.s.emit(r.id, "evidence", *r.held)
		r.evidence++
		r.held = nil
	}
}

// finishStream decides the outcome once the stream has ended. Only the LAST line decides: a "status" line forged by
// the collector earlier in the stream is plain evidence.
func (r *runExec) finishStream(ctx context.Context, exitHandled <-chan struct{}) error {
	status := ""
	if r.held != nil {
		status = parseStatus(*r.held)
	}
	if status != "" {
		r.s.emit(r.id, "status", *r.held)
		r.held = nil
	} else {
		r.flushHeld()
	}
	switch {
	case status == "":
		// the stream ended without a status: either the VM died (its exit may be a moment behind) or the agent misbehaved
		select {
		case <-exitHandled:
		case <-time.After(300 * time.Millisecond):
		}
		if ctx.Err() != nil {
			return causeOf(ctx, ReasonInternal) // the VM's exit cancelled the run: fc_crashed, or supervisor_restart while draining
		}
		reason := ReasonAgentError
		if r.vmDead.Load() {
			reason = ReasonFcCrashed
		}
		r.out = outcome{state: StateFailed, reason: reason}
	case status == "ok":
		r.out = outcome{state: StateDone, agentStatus: status}
	default:
		reason, known := agentStatusReason[status]
		if !known {
			reason = ReasonAgentError
		}
		r.out = outcome{state: StateFailed, reason: reason, agentStatus: status}
	}
	return nil
}

// onControlLine moves the session's command state on the collector lines that drive it. They are evidence like any
// other (already published); only the shapes the collector produces count (spec 005, 3.5).
func (r *runExec) onControlLine(line string) {
	if r.sess == nil || len(line) > controlLineMax {
		return
	}
	if !strings.Contains(line, `"session_ready"`) && !strings.Contains(line, `"cmd_result"`) {
		return
	}
	var o map[string]any
	if json.Unmarshal([]byte(line), &o) != nil || o["type"] != "evidence" {
		return
	}
	switch o["kind"] {
	case "session_ready":
		if r.sess.MarkReady() {
			r.s.setState(r.id, StateSession, nil)
		}
	case "cmd_result":
		cid, idOK := o["id"].(string)
		okv, okOK := o["ok"].(bool)
		if idOK && okOK {
			// the error code comes from the guest: only a short lowercase token is passed on
			code := ""
			if e, isStr := o["error"].(string); isStr && errorCodeRe.MatchString(e) {
				code = e
			}
			r.sess.OnResult(cid, okv, code)
		}
	}
}

// onArtifactLine starts a fetch for an artifact the collector announces, while the VM is alive (spec 005, 3.6). The
// event the collector wrote is only a claim: it names the file and the size to expect, and everything published
// about the file is measured here. Fetches run beside the stream and are all finished before the VM is stopped.
func (r *runExec) onArtifactLine(ctx context.Context, line string) {
	s := r.s
	if s.artifacts == nil || len(line) > controlLineMax || !strings.Contains(line, `"artifact"`) {
		return
	}
	var o map[string]any
	if json.Unmarshal([]byte(line), &o) != nil || o["type"] != "evidence" || o["kind"] != "artifact" || o["saved"] != true {
		return
	}
	name, _ := o["file"].(string)
	declared, isNum := o["bytes"].(float64)
	if !artifactNameRe.MatchString(name) || !isNum || declared != math.Trunc(declared) || declared < 1 || declared > float64(s.cfg.MaxArtifactBytes) {
		s.log("warn", "artifact announcement ignored", map[string]any{"run_id": r.id})
		return
	}
	need := int64(declared)
	b := r.vmForCommands.Load()
	r.artMu.Lock()
	if r.artSeen[name] || b == nil {
		r.artMu.Unlock()
		return
	}
	r.artSeen[name] = true
	if r.artFiles >= s.cfg.MaxArtifacts || r.artBytes+need > s.cfg.MaxArtifactBytes {
		r.artMu.Unlock()
		s.emit(r.id, "artifact", toJSON(ArtifactInfo{Name: name, Error: ArtLimit}))
		return
	}
	r.artFiles++
	r.artBytes += need
	r.artMu.Unlock()
	r.fetches.Add(1)
	go r.fetchArtifact(ctx, b.vm, name, need)
}

func (r *runExec) fetchArtifact(ctx context.Context, vm VM, name string, need int64) {
	defer r.fetches.Done()
	s := r.s
	timeout := s.cfg.ArtifactFetchTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	fctx, fcancel := context.WithTimeout(ctx, timeout)
	defer fcancel()
	info, code := s.artifacts.Put(r.id, name, need, func(w io.Writer, max int64) (int64, error) {
		return vm.FetchArtifact(fctx, name, w, max)
	})
	if code != "" {
		info = ArtifactInfo{Name: name, Error: code}
		if ctx.Err() == nil {
			s.log("warn", "artifact not stored", map[string]any{"run_id": r.id, "name": name, "error": code})
		}
	}
	s.emit(r.id, "artifact", toJSON(info))
}

func (r *runExec) recordFailure(ctx context.Context, err error) {
	var re *RunError
	if ctx.Err() != nil {
		re = causeOf(ctx, ReasonInternal)
	} else {
		re = asRunError(err, ReasonInternal)
	}
	r.out = outcome{state: StateFailed, reason: re.Reason}
	level := "warn"
	if re.Reason == ReasonInternal {
		level = "error"
	}
	r.s.log(level, "run failed", map[string]any{"run_id": r.id, "reason": re.Reason, "detail": clip(re.Error(), 200)})
	r.flushHeld()
}

// teardown runs always, whatever happened in steps().
func (r *runExec) teardown() {
	s, id := r.s, r.id
	r.fetches.Wait() // the guest is still there; a cancelled run aborts its fetches at once, a normal one waits a moment
	r.hard.Stop()
	r.destroying.Store(true)
	if r.sess != nil {
		r.sess.End() // open commands are voided and published before the run leaves the session
	}
	s.setState(id, StateDestroying, nil)
	if r.vm != nil {
		r.vm.Stop()
	}
	// a VM that is still there keeps its slot: the next VM of the slot would run as the same user (review E)
	gone := r.vm == nil || r.vm.Gone()
	bg := context.Background()
	if r.netTouched {
		if err := s.backend.NetDown(bg, r.slot, id); err != nil {
			s.log("error", "netDown failed", map[string]any{"run_id": id, "slot": r.slot, "detail": clip(err.Error(), 200)})
		}
	}
	if err := s.backend.RemoveRunDir(r.runDir); err != nil {
		s.log("error", "removeRunDir failed", map[string]any{"run_id": id, "detail": clip(err.Error(), 200)})
	}
	s.mu.Lock()
	if gone {
		s.pool.Release(r.slot)
	} else {
		s.quarantined[r.slot] = r.vm
	}
	if r.rec.Session != nil {
		s.sessionRuns--
	}
	delete(s.active, id)
	s.setStateLocked(id, r.out.state, func(rec *RunRecord) {
		rec.Reason = r.out.reason
		rec.AgentStatus = r.out.agentStatus
		rec.Partial = r.out.state == StateFailed && r.evidence > 0
		rec.FinishedAt = ptr(s.now())
		rec.Events = s.seqs[id]
	})
	s.mu.Unlock()
	if !gone {
		s.log("error", "the VM did not end: its slot is held until it does", map[string]any{"run_id": id, "slot": r.slot})
	}
	s.log("info", "run finished", map[string]any{"run_id": id, "state": r.out.state, "reason": r.out.reason})
	s.mu.Lock()
	s.pumpLocked()
	s.mu.Unlock()
}
