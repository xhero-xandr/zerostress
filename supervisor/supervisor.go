package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrQueueFull        = errors.New("queue is full")
	ErrDraining         = errors.New("shutting down")
	ErrLowDisk          = errors.New("not enough free disk space")
	ErrSessionsDisabled = errors.New("sessions are disabled")
)

// The agent's own status line is a few dozen bytes; a longer line can never be one.
const statusLineMax = 512

// Only short collector lines can be session_ready or cmd_result.
const controlLineMax = 4096

// errorCodeRe is the shape of an error code passed on from the guest.
var errorCodeRe = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)

var agentStatusReason = map[string]FailReason{
	"exited_nonzero": ReasonCollectorFailed,
	"start_failed":   ReasonCollectorFailed,
	"timeout":        ReasonTimeout,
	"oversize":       ReasonOversize,
}

type Deps struct {
	Config  Config
	Store   *Store
	Results *ResultFiles
	// Artifacts is optional: without it artifact events are passed on as they are and nothing is fetched.
	Artifacts *ArtifactFiles
	Backend   Backend
	Log       Logger
	// Now returns Unix milliseconds. Tests may replace it.
	Now         func() int64
	FreeGB      func() float64
	ImageSHA256 func() string
	// SweepEvery is the interval of the stale-queue sweep; tests shorten it.
	SweepEvery time.Duration
}

type subscriber struct {
	ch      chan RunEvent
	dropped bool
}

// Subscription is a replay of stored events followed by live ones. If the reader is too slow its channel is closed and
// Dropped reports true: it must reconnect with the last sequence number it saw.
type Subscription struct {
	Replay  []RunEvent
	Events  <-chan RunEvent
	Close   func()
	Dropped func() bool
}

type activeRun struct {
	cancel context.CancelCauseFunc
	done   chan struct{}
}

type Supervisor struct {
	cfg       Config
	store     *Store
	results   *ResultFiles
	artifacts *ArtifactFiles
	backend   Backend
	log       Logger
	now       func() int64
	freeGB    func() float64
	imageSH   func() string
	sweep     time.Duration

	mu          sync.Mutex // guards everything below
	pool        *SlotPool
	queue       []string
	active      map[string]*activeRun
	sessions    map[string]*SessionCommands // kept after the run ends (everything voided) so the totals stay readable
	sessionRuns int
	listeners   map[string]map[*subscriber]struct{}
	seqs        map[string]int

	draining atomic.Bool
	bgCancel context.CancelFunc
}

func NewSupervisor(d Deps) *Supervisor {
	s := &Supervisor{
		cfg: d.Config, store: d.Store, results: d.Results, artifacts: d.Artifacts, backend: d.Backend, log: d.Log,
		now: d.Now, freeGB: d.FreeGB, imageSH: d.ImageSHA256, sweep: d.SweepEvery,
		pool:      NewSlotPool(d.Config.Concurrency),
		active:    map[string]*activeRun{},
		sessions:  map[string]*SessionCommands{},
		listeners: map[string]map[*subscriber]struct{}{},
		seqs:      map[string]int{},
	}
	if s.log == nil {
		s.log = nullLogger
	}
	if s.now == nil {
		s.now = func() int64 { return time.Now().UnixMilli() }
	}
	if s.freeGB == nil {
		s.freeGB = func() float64 { return math.Inf(1) }
	}
	if s.imageSH == nil {
		s.imageSH = func() string { return "" }
	}
	if s.sweep == 0 {
		s.sweep = time.Second
	}
	return s
}

// ---- lifecycle of the service ------------------------------------------------------------------------------

// Start runs the recovery of spec 006, 3.5, then begins accepting work.
func (s *Supervisor) Start(ctx context.Context) error {
	if err := s.backend.RecoverHost(ctx); err != nil {
		s.log("warn", "recovery failed", map[string]any{"detail": clip(err.Error(), 200)})
	}
	s.mu.Lock()
	for _, rec := range s.store.InFlight() {
		s.voidDanglingCommandsLocked(rec.ID)
		s.setStateLocked(rec.ID, StateFailed, func(r *RunRecord) {
			r.Reason = ReasonSupervisorRestart
			r.FinishedAt = ptr(s.now())
		})
	}
	for _, rec := range s.store.Queued() {
		s.queue = append(s.queue, rec.ID)
	}
	bg, cancel := context.WithCancel(context.Background())
	s.bgCancel = cancel
	s.removeExpiredLocked()
	s.pumpLocked()
	s.mu.Unlock()

	go s.every(bg, s.sweep, s.sweepQueue)
	go s.every(bg, 10*time.Minute, func() {
		s.mu.Lock()
		s.removeExpiredLocked()
		s.mu.Unlock()
	})
	return nil
}

func (s *Supervisor) every(ctx context.Context, d time.Duration, f func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

// Shutdown stops taking work, gives running runs a moment, then forces them down. Queued runs stay in the store.
func (s *Supervisor) Shutdown() {
	s.draining.Store(true)
	if s.bgCancel != nil {
		s.bgCancel()
	}
	s.mu.Lock()
	runs := make([]*activeRun, 0, len(s.active))
	for _, a := range s.active {
		runs = append(runs, a)
	}
	s.mu.Unlock()
	waitAll := func() {
		for _, a := range runs {
			<-a.done
		}
	}
	finished := make(chan struct{})
	go func() { waitAll(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(s.cfg.ShutdownGrace):
		for _, a := range runs {
			a.cancel(newRunError(ReasonSupervisorRestart, ""))
		}
		<-finished
	}
}

// ---- API used by the HTTP layer ----------------------------------------------------------------------------

type SubmitResult struct {
	RunID    string   `json:"run_id"`
	State    RunState `json:"state"`
	Position *int     `json:"position"`
	Session  bool     `json:"session,omitempty"`
}

func (s *Supervisor) Submit(url string, session *SessionLimits) (SubmitResult, error) {
	if s.draining.Load() {
		return SubmitResult{}, ErrDraining
	}
	if s.freeGB() < float64(s.cfg.MinFreeGB) {
		return SubmitResult{}, ErrLowDisk
	}
	if session != nil && s.cfg.SessionSlots == 0 {
		return SubmitResult{}, ErrSessionsDisabled
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.queue) >= s.cfg.QueueMax {
		return SubmitResult{}, ErrQueueFull
	}
	id, err := newUUID()
	if err != nil {
		return SubmitResult{}, err
	}
	created := s.now()
	if err := s.store.Insert(RunRecord{ID: id, URL: url, CreatedAt: created, ExpiresAt: created + s.cfg.ResultTTL.Milliseconds(), Session: session}); err != nil {
		return SubmitResult{}, err
	}
	s.seqs[id] = 0
	rec, _ := s.store.Get(id)
	s.queue = append(s.queue, id)
	s.emitLocked(id, "state", s.stateDataLocked(rec))
	s.log("info", "run accepted", merge(map[string]any{"run_id": id}, UrlInfo(url)))
	s.pumpLocked()
	now, _ := s.store.Get(id)
	return SubmitResult{RunID: id, State: now.State, Position: s.positionOfLocked(id)}, nil
}

type SessionView struct {
	IdleS int `json:"idle_s"`
	MaxS  int `json:"max_s"`
}

type RunView struct {
	RunID       string         `json:"run_id"`
	State       RunState       `json:"state"`
	Reason      *FailReason    `json:"reason"`
	Position    *int           `json:"position"`
	CreatedAt   string         `json:"created_at"`
	StartedAt   *string        `json:"started_at"`
	FinishedAt  *string        `json:"finished_at"`
	AgentStatus *string        `json:"agent_status"`
	Partial     bool           `json:"partial"`
	Events      int            `json:"events"`
	ExpiresAt   string         `json:"expires_at"`
	Session     *SessionView   `json:"session,omitempty"`
	Commands    *CommandCounts `json:"commands,omitempty"`
}

func isoTime(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

func (s *Supervisor) Get(id string) (RunView, bool) {
	rec, ok := s.store.Get(id)
	if !ok {
		return RunView{}, false
	}
	s.mu.Lock()
	v := RunView{
		RunID: rec.ID, State: rec.State, CreatedAt: isoTime(rec.CreatedAt), Partial: rec.Partial, ExpiresAt: isoTime(rec.ExpiresAt),
		Events: rec.Events,
	}
	if seq, ok := s.seqs[rec.ID]; ok {
		v.Events = seq
	}
	if rec.State == StateQueued {
		v.Position = s.positionOfLocked(rec.ID)
	}
	sess := s.sessions[rec.ID]
	s.mu.Unlock()
	if rec.Reason != "" {
		r := rec.Reason
		v.Reason = &r
	}
	if rec.StartedAt != nil {
		t := isoTime(*rec.StartedAt)
		v.StartedAt = &t
	}
	if rec.FinishedAt != nil {
		t := isoTime(*rec.FinishedAt)
		v.FinishedAt = &t
	}
	if rec.AgentStatus != "" {
		a := rec.AgentStatus
		v.AgentStatus = &a
	}
	if rec.Session != nil {
		v.Session = &SessionView{IdleS: int(math.Round(float64(rec.Session.IdleMs) / 1000)), MaxS: int(math.Round(float64(rec.Session.MaxMs) / 1000))}
		if sess != nil {
			// outside s.mu: the session calls Emit (which takes s.mu) while it holds its own lock, so the order is always
			// session lock first, supervisor lock second
			c := sess.Counts()
			v.Commands = &c
		}
	}
	return v, true
}

// Cancel returns "cancelled" (removed from the queue), "cancelling", "conflict" (already finished) or "not_found".
func (s *Supervisor) Cancel(id string) string {
	rec, ok := s.store.Get(id)
	if !ok {
		return "not_found"
	}
	if rec.State.Terminal() {
		return "conflict"
	}
	s.mu.Lock()
	for i, q := range s.queue {
		if q == id {
			s.queue = append(s.queue[:i], s.queue[i+1:]...)
			s.setStateLocked(id, StateFailed, func(r *RunRecord) {
				r.Reason = ReasonCancelled
				r.FinishedAt = ptr(s.now())
			})
			s.announcePositionsLocked()
			s.mu.Unlock()
			return "cancelled"
		}
	}
	a := s.active[id]
	s.mu.Unlock()
	if a != nil {
		a.cancel(newRunError(ReasonCancelled, ""))
	}
	return "cancelling"
}

// Subscribe returns the stored events after afterSeq and a channel of live ones. The caller ends the stream on a
// terminal state event. Reading the file and registering happen under the lock that appends take, so no event can
// slip between the two.
func (s *Supervisor) Subscribe(id string, afterSeq int) (*Subscription, bool) {
	if _, ok := s.store.Get(id); !ok {
		return nil, false
	}
	sub := &subscriber{ch: make(chan RunEvent, 4096)}
	s.mu.Lock()
	replay := s.results.Read(id, afterSeq)
	set := s.listeners[id]
	if set == nil {
		set = map[*subscriber]struct{}{}
		s.listeners[id] = set
	}
	set[sub] = struct{}{}
	s.mu.Unlock()
	return &Subscription{
		Replay: replay,
		Events: sub.ch,
		Close: func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.dropLocked(id, sub, false)
		},
		Dropped: func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return sub.dropped
		},
	}, true
}

func (s *Supervisor) dropLocked(id string, sub *subscriber, overflow bool) {
	set := s.listeners[id]
	if _, ok := set[sub]; !ok {
		return
	}
	delete(set, sub)
	if len(set) == 0 {
		delete(s.listeners, id)
	}
	sub.dropped = overflow
	close(sub.ch)
}

type SessionsHealth struct {
	Running int `json:"running"`
	Limit   int `json:"limit"`
}

type Health struct {
	OK          bool           `json:"ok"`
	Version     string         `json:"version"`
	Concurrency int            `json:"concurrency"`
	Running     int            `json:"running"`
	Queued      int            `json:"queued"`
	Sessions    SessionsHealth `json:"sessions"`
	FreeGB      *int           `json:"free_gb"`
	ImageSHA256 *string        `json:"image_sha256"`
}

func (s *Supervisor) Health() Health {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := Health{
		OK: true, Version: "0.2.0", Concurrency: s.cfg.Concurrency, Running: len(s.active), Queued: len(s.queue),
		Sessions: SessionsHealth{Running: s.sessionRuns, Limit: s.cfg.SessionSlots},
	}
	if g := s.freeGB(); !math.IsInf(g, 0) {
		v := int(math.Floor(g))
		h.FreeGB = &v
	}
	if sh := s.imageSH(); sh != "" {
		h.ImageSHA256 = &sh
	}
	return h
}

// ---- session commands (spec 006, 3.8) ----------------------------------------------------------------------

func (s *Supervisor) sessionOf(id string) *SessionCommands {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[id]
}

func (s *Supervisor) SubmitCommand(id string, body any) (SubmitOK, *CmdError) {
	if _, ok := s.store.Get(id); !ok {
		return SubmitOK{}, &CmdError{"not_found", "no such run"}
	}
	sess := s.sessionOf(id)
	if sess == nil {
		return SubmitOK{}, &CmdError{"not_session", "the run is not a session"}
	}
	return sess.Submit(body)
}

func (s *Supervisor) liveSession(id string) (*SessionCommands, *CmdError) {
	if _, ok := s.store.Get(id); !ok {
		return nil, &CmdError{"not_found", "no such run"}
	}
	sess := s.sessionOf(id)
	if sess == nil {
		return nil, &CmdError{"not_found", "no such session"}
	}
	return sess, nil
}

func (s *Supervisor) ApproveCommand(id, commandID string, sha256 any) *CmdError {
	sess, err := s.liveSession(id)
	if err != nil {
		return err
	}
	return sess.Approve(commandID, sha256)
}

func (s *Supervisor) RejectCommand(id, commandID string) *CmdError {
	sess, err := s.liveSession(id)
	if err != nil {
		return err
	}
	return sess.Reject(commandID)
}

// ---- queue -------------------------------------------------------------------------------------------------

func (s *Supervisor) positionOfLocked(id string) *int {
	for i, q := range s.queue {
		if q == id {
			p := i + 1
			return &p
		}
	}
	return nil
}

func (s *Supervisor) announcePositionsLocked() {
	for _, id := range s.queue {
		if rec, ok := s.store.Get(id); ok {
			s.emitLocked(id, "state", s.stateDataLocked(rec))
		}
	}
}

func (s *Supervisor) eligibleLocked(id string) bool {
	rec, ok := s.store.Get(id)
	if !ok || rec.State != StateQueued {
		return true // dropped by the caller
	}
	return rec.Session == nil || s.sessionRuns < s.cfg.SessionSlots
}

func (s *Supervisor) pumpLocked() {
	if s.draining.Load() {
		return
	}
	moved := false
	for len(s.queue) > 0 {
		slot := s.pool.Acquire()
		if slot < 0 {
			break
		}
		// FIFO, except that a session waits for a free session slot while plain runs pass it
		qi := -1
		for i, q := range s.queue {
			if s.eligibleLocked(q) {
				qi = i
				break
			}
		}
		if qi < 0 {
			s.pool.Release(slot)
			break
		}
		id := s.queue[qi]
		s.queue = append(s.queue[:qi], s.queue[qi+1:]...)
		moved = true
		rec, ok := s.store.Get(id)
		if !ok || rec.State != StateQueued {
			s.pool.Release(slot)
			continue
		}
		if s.now()-rec.CreatedAt > s.cfg.QueueWait.Milliseconds() {
			s.pool.Release(slot)
			s.setStateLocked(id, StateFailed, func(r *RunRecord) {
				r.Reason = ReasonQueueTimeout
				r.FinishedAt = ptr(s.now())
			})
			continue
		}
		ctx, cancel := context.WithCancelCause(context.Background())
		if rec.Session != nil {
			s.sessionRuns++
		}
		a := &activeRun{cancel: cancel, done: make(chan struct{})}
		s.active[id] = a
		go s.execute(rec, slot, ctx, cancel, a)
	}
	if moved {
		s.announcePositionsLocked()
	}
}

func (s *Supervisor) sweepQueue() {
	s.mu.Lock()
	defer s.mu.Unlock()
	var keep []string
	changed := false
	for _, id := range s.queue {
		rec, ok := s.store.Get(id)
		if ok && s.now()-rec.CreatedAt > s.cfg.QueueWait.Milliseconds() {
			s.setStateLocked(id, StateFailed, func(r *RunRecord) {
				r.Reason = ReasonQueueTimeout
				r.FinishedAt = ptr(s.now())
			})
			changed = true
			continue
		}
		keep = append(keep, id)
	}
	s.queue = keep
	if changed {
		s.announcePositionsLocked()
	}
}

func (s *Supervisor) removeExpiredLocked() {
	for _, id := range s.store.Expired(s.now()) {
		s.results.Delete(id)
		if s.artifacts != nil {
			s.artifacts.Delete(id)
		}
		s.store.Delete(id)
		delete(s.seqs, id)
		delete(s.sessions, id)
	}
}

// ---- one run -----------------------------------------------------------------------------------------------

type vmBox struct{ vm VM }

type outcome struct {
	state       RunState
	reason      FailReason
	agentStatus string
}

// execute never fails: every outcome ends in a terminal state, and resources are released in the deferred part.
func (s *Supervisor) execute(rec RunRecord, slot int, ctx context.Context, cancel context.CancelCauseFunc, a *activeRun) {
	defer close(a.done)
	id := rec.ID
	runDir := filepath.Join(s.cfg.RunsDir, id)
	var vm VM
	netTouched := false
	var destroying, vmDead atomic.Bool
	var vmForCommands atomic.Pointer[vmBox]
	var held *string
	evidence, evidenceBytes := 0, 0
	out := outcome{state: StateFailed, reason: ReasonInternal}

	// A session lives for its own time, and the supervisor keeps a ceiling of its own that does not depend on the collector.
	hardFor := s.cfg.HardTimeout
	if rec.Session != nil {
		hardFor = s.cfg.BootTimeout + time.Duration(rec.Session.MaxMs)*time.Millisecond + s.cfg.SessionGrace
	}
	hard := time.AfterFunc(hardFor, func() { cancel(newRunError(ReasonTimeout, "hard timeout")) })

	var sess *SessionCommands
	if rec.Session != nil {
		sess = NewSessionCommands(SessionOptions{
			Idle:           time.Duration(rec.Session.IdleMs) * time.Millisecond,
			CommandMax:     s.cfg.CommandMax,
			CommandTimeout: s.cfg.CommandTimeout,
			ApprovalTTL:    s.cfg.ApprovalTTL,
			Now:            s.now,
			Send: func(line string) error {
				b := vmForCommands.Load()
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
			Abort: func(e *RunError) { cancel(e) },
		})
		s.mu.Lock()
		s.sessions[id] = sess
		s.mu.Unlock()
	}

	flushHeld := func() {
		if held != nil {
			s.emit(id, "evidence", *held)
			evidence++
			held = nil
		}
	}

	// Collector lines that drive the session. They are evidence like any other (already published); here they only move
	// the command state, and only in the shapes the collector produces (spec 005, 3.5).
	controlLine := func(line string) {
		if sess == nil || len(line) > controlLineMax {
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
			if sess.MarkReady() {
				s.setState(id, StateSession, nil)
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
				sess.OnResult(cid, okv, code)
			}
		}
	}

	// Artifacts the collector announces are fetched from the guest while the VM is alive (spec 005, 3.6). The event the
	// collector wrote is only a claim: it names the file and the size to expect, and everything published about the
	// file is measured here. Fetches run beside the stream and are all finished before the VM is stopped.
	var fetches sync.WaitGroup
	var artMu sync.Mutex
	artSeen := map[string]bool{}
	artFiles, artBytes := 0, int64(0)
	artifactLine := func(line string) {
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
			s.log("warn", "artifact announcement ignored", map[string]any{"run_id": id})
			return
		}
		need := int64(declared)
		b := vmForCommands.Load()
		artMu.Lock()
		if artSeen[name] || b == nil {
			artMu.Unlock()
			return
		}
		artSeen[name] = true
		if artFiles >= s.cfg.MaxArtifacts || artBytes+need > s.cfg.MaxArtifactBytes {
			artMu.Unlock()
			s.emit(id, "artifact", toJSON(ArtifactInfo{Name: name, Error: ArtLimit}))
			return
		}
		artFiles++
		artBytes += need
		artMu.Unlock()
		fetches.Add(1)
		go func() {
			defer fetches.Done()
			timeout := s.cfg.ArtifactFetchTimeout
			if timeout <= 0 {
				timeout = 20 * time.Second
			}
			fctx, fcancel := context.WithTimeout(ctx, timeout)
			defer fcancel()
			info, code := s.artifacts.Put(id, name, need, func(w io.Writer, max int64) (int64, error) {
				return b.vm.FetchArtifact(fctx, name, w, max)
			})
			if code != "" {
				info = ArtifactInfo{Name: name, Error: code}
				if ctx.Err() == nil {
					s.log("warn", "artifact not stored", map[string]any{"run_id": id, "name": name, "error": code})
				}
			}
			s.emit(id, "artifact", toJSON(info))
		}()
	}

	// failed turns an error from a step into the run's failure: the cause of an aborted run beats the step's own error.
	failed := func(err error, fallback FailReason) error {
		if ctx.Err() != nil {
			return causeOf(ctx, ReasonInternal)
		}
		return asRunError(err, fallback)
	}

	err := func() error {
		s.setState(id, StatePreparing, func(r *RunRecord) {
			r.Slot = &slot
			r.StartedAt = ptr(s.now())
		})
		if err := s.backend.PrepareDisk(ctx, runDir); err != nil {
			return failed(err, ReasonDiskCopy)
		}
		netTouched = true
		if err := s.backend.NetUp(ctx, slot, id); err != nil {
			return failed(err, ReasonNetSetup)
		}
		s.setState(id, StateBooting, nil)
		v, err := s.backend.Start(ctx, StartOptions{RunID: id, RunDir: runDir, Slot: slot, VCPU: s.cfg.VCPU, MemMiB: s.cfg.MemMiB})
		if err != nil {
			return failed(err, ReasonFcAPI)
		}
		vm = v
		// exitHandled is closed once the exit of the VM has been fully accounted for (flag set, run cancelled if that was
		// not our own doing). Waiting on Exited() alone would race with this goroutine.
		exitHandled := make(chan struct{})
		go func() {
			defer close(exitHandled)
			<-v.Exited()
			vmDead.Store(true)
			// while we are shutting down, a dying VM is our own doing (or systemd's), not a crash
			if !destroying.Load() {
				if s.draining.Load() {
					cancel(newRunError(ReasonSupervisorRestart, ""))
				} else {
					cancel(newRunError(ReasonFcCrashed, "firecracker exited"))
				}
			}
		}()
		if err := v.WaitReady(ctx, s.cfg.BootTimeout); err != nil {
			return failed(err, ReasonBootTimeout)
		}
		vmForCommands.Store(&vmBox{vm: v})

		s.setState(id, StateRunning, nil)
		// The guest gets only the total time. Idle time belongs to the supervisor (it alone knows when a human is
		// deciding about a risky command), which sends a normal close when the session has been idle for too long.
		job := jobLine(id, rec)
		runErr := v.RunJob(ctx, job, func(line string) {
			evidenceBytes += len(line) + 1
			if evidenceBytes > s.cfg.MaxEvidenceBytes {
				cancel(newRunError(ReasonOversize, "evidence cap exceeded"))
				return
			}
			flushHeld()
			// Only a line that looks like a status line is held back, until the next line shows whether it was the
			// last one. Everything else is published at once, so a session's evidence is live, not one line late.
			if len(line) <= statusLineMax && parseStatus(line) != "" {
				l := line
				held = &l
				return
			}
			s.emit(id, "evidence", line)
			evidence++
			controlLine(line)
			artifactLine(line)
		})
		if runErr != nil {
			return failed(runErr, ReasonAgentError)
		}
		if ctx.Err() != nil {
			return causeOf(ctx, ReasonInternal)
		}

		// only the LAST line decides: a "status" line forged by the collector earlier in the stream is plain evidence
		status := ""
		if held != nil {
			status = parseStatus(*held)
		}
		if status != "" {
			s.emit(id, "status", *held)
			held = nil
		} else {
			flushHeld()
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
			if vmDead.Load() {
				reason = ReasonFcCrashed
			}
			out = outcome{state: StateFailed, reason: reason}
		case status == "ok":
			out = outcome{state: StateDone, agentStatus: status}
		default:
			reason, known := agentStatusReason[status]
			if !known {
				reason = ReasonAgentError
			}
			out = outcome{state: StateFailed, reason: reason, agentStatus: status}
		}
		return nil
	}()
	if err != nil {
		var re *RunError
		if ctx.Err() != nil {
			re = causeOf(ctx, ReasonInternal)
		} else {
			re = asRunError(err, ReasonInternal)
		}
		out = outcome{state: StateFailed, reason: re.Reason}
		level := "warn"
		if re.Reason == ReasonInternal {
			level = "error"
		}
		s.log(level, "run failed", map[string]any{"run_id": id, "reason": re.Reason, "detail": clip(re.Error(), 200)})
		flushHeld()
	}

	// ---- teardown: always, whatever happened above ----
	fetches.Wait() // the guest is still there; a cancelled run aborts its fetches at once, a normal one waits a moment
	hard.Stop()
	destroying.Store(true)
	if sess != nil {
		sess.End() // open commands are voided and published before the run leaves the session
	}
	s.setState(id, StateDestroying, nil)
	if vm != nil {
		vm.Stop()
	}
	bg := context.Background()
	if netTouched {
		if err := s.backend.NetDown(bg, slot, id); err != nil {
			s.log("error", "netDown failed", map[string]any{"run_id": id, "slot": slot, "detail": clip(err.Error(), 200)})
		}
	}
	if err := s.backend.RemoveRunDir(runDir); err != nil {
		s.log("error", "removeRunDir failed", map[string]any{"run_id": id, "detail": clip(err.Error(), 200)})
	}
	s.mu.Lock()
	s.pool.Release(slot)
	if rec.Session != nil {
		s.sessionRuns--
	}
	delete(s.active, id)
	s.setStateLocked(id, out.state, func(r *RunRecord) {
		r.Reason = out.reason
		r.AgentStatus = out.agentStatus
		r.Partial = out.state == StateFailed && evidence > 0
		r.FinishedAt = ptr(s.now())
		r.Events = s.seqs[id]
	})
	s.mu.Unlock()
	s.log("info", "run finished", map[string]any{"run_id": id, "state": out.state, "reason": out.reason})
	s.mu.Lock()
	s.pumpLocked()
	s.mu.Unlock()
}

func jobLine(runID string, rec RunRecord) string {
	type sessionJob struct {
		MaxS int `json:"max_s"`
	}
	type job struct {
		Schema  int         `json:"schema"`
		RunID   string      `json:"run_id"`
		Kind    string      `json:"kind"`
		URL     string      `json:"url"`
		Session *sessionJob `json:"session,omitempty"`
	}
	j := job{Schema: 1, RunID: runID, Kind: "url", URL: rec.URL}
	if rec.Session != nil {
		maxS := int(math.Ceil(float64(rec.Session.MaxMs) / 1000))
		if maxS < 1 {
			maxS = 1
		}
		j.Session = &sessionJob{MaxS: maxS}
	}
	return toJSON(j)
}

// ---- state and events --------------------------------------------------------------------------------------

type stateEvent struct {
	State       RunState   `json:"state"`
	Reason      FailReason `json:"reason,omitempty"`
	Position    *int       `json:"position,omitempty"`
	AgentStatus string     `json:"agent_status,omitempty"`
	Partial     bool       `json:"partial,omitempty"`
}

func (s *Supervisor) setState(id string, state RunState, patch func(*RunRecord)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setStateLocked(id, state, patch)
}

func (s *Supervisor) setStateLocked(id string, state RunState, patch func(*RunRecord)) {
	if err := s.store.Update(id, func(r *RunRecord) {
		if patch != nil {
			patch(r)
		}
		r.State = state
	}); err != nil {
		s.log("error", "state update failed", map[string]any{"run_id": id, "detail": clip(err.Error(), 200)})
		return
	}
	if rec, ok := s.store.Get(id); ok {
		s.emitLocked(id, "state", s.stateDataLocked(rec))
	}
}

func (s *Supervisor) stateDataLocked(rec RunRecord) string {
	ev := stateEvent{State: rec.State, Reason: rec.Reason, AgentStatus: rec.AgentStatus, Partial: rec.Partial}
	if rec.State == StateQueued {
		ev.Position = s.positionOfLocked(rec.ID)
	}
	return toJSON(ev)
}

func (s *Supervisor) emit(id, typ, data string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emitLocked(id, typ, data)
}

func (s *Supervisor) emitLocked(id, typ, data string) {
	seq, ok := s.seqs[id]
	if !ok {
		seq = s.results.LastSeq(id)
	}
	seq++
	s.seqs[id] = seq
	ev := RunEvent{Seq: seq, Type: typ, Data: data}
	if err := s.results.Append(id, ev); err != nil {
		s.log("error", "event write failed", map[string]any{"run_id": id, "detail": clip(err.Error(), 200)})
	}
	for sub := range s.listeners[id] {
		select {
		case sub.ch <- ev:
		default:
			// a reader that cannot keep up is cut off; it reconnects with Last-Event-ID and gets the rest from the file
			s.dropLocked(id, sub, true)
		}
	}
}

// voidDanglingCommandsLocked: after a restart the commands of a dead session can no longer run; say so in its event log.
func (s *Supervisor) voidDanglingCommandsLocked(id string) {
	last := map[string]CommandEvent{}
	var order []string
	for _, ev := range s.results.Read(id, 0) {
		if ev.Type != "command" {
			continue
		}
		var c CommandEvent
		if json.Unmarshal([]byte(ev.Data), &c) != nil || c.CommandID == "" {
			continue
		}
		if _, seen := last[c.CommandID]; !seen {
			order = append(order, c.CommandID)
		}
		last[c.CommandID] = c
	}
	for _, cid := range order {
		c := last[cid]
		if !IsOpenStatus(string(c.Status)) {
			continue
		}
		s.emitLocked(id, "command", toJSON(CommandEvent{CommandID: c.CommandID, Cmd: c.Cmd, Status: CmdVoided, Risk: c.Risk, SHA256: c.SHA256}))
	}
}

// ---- helpers -----------------------------------------------------------------------------------------------

// parseStatus returns the status of an agent status line, or "" if the line is not one.
func parseStatus(line string) string {
	var o map[string]any
	if json.Unmarshal([]byte(line), &o) != nil || o["type"] != "status" {
		return ""
	}
	st, _ := o["status"].(string)
	return st
}

// toJSON writes v on one line without escaping <, > and &, as JSON.stringify does.
func toJSON(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "{}"
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func ptr[T any](v T) *T { return &v }

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func merge(a, b map[string]any) map[string]any {
	for k, v := range b {
		a[k] = v
	}
	return a
}

func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
