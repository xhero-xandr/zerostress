package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// The command side of one interactive session (spec 006, 3.7-3.8): validation, one-at-a-time execution, hash-bound
// one-time approvals for risky commands, and the session clock. It knows nothing about VMs or HTTP; the supervisor
// wires Send, Emit and Abort. Everything a guest says can only move a command from sent to done or error, and only
// for the command that is in flight.
//
// Locking: one mutex guards everything. Send, Emit and Abort are called with it held, so they must not call back into
// the session.

type CommandStatus string

const (
	CmdAccepted         CommandStatus = "accepted"
	CmdAwaitingApproval CommandStatus = "awaiting_approval"
	CmdApproved         CommandStatus = "approved"
	CmdSent             CommandStatus = "sent"
	CmdDone             CommandStatus = "done"
	CmdErrored          CommandStatus = "error"
	CmdRejected         CommandStatus = "rejected"
	CmdExpired          CommandStatus = "expired"
	CmdVoided           CommandStatus = "voided"
	CmdTimeout          CommandStatus = "timeout"
)

// IsOpenStatus tells whether a command in this status can still change.
func IsOpenStatus(s string) bool {
	switch CommandStatus(s) {
	case CmdAccepted, CmdAwaitingApproval, CmdApproved, CmdSent:
		return true
	}
	return false
}

// CommandEvent is the data of a `command` event. The field order is part of the contract (and of the e2e tests).
type CommandEvent struct {
	CommandID string          `json:"command_id"`
	Cmd       string          `json:"cmd"`
	Status    CommandStatus   `json:"status"`
	Risk      Risk            `json:"risk"`
	SHA256    string          `json:"command_sha256"`
	By        string          `json:"by,omitempty"`
	Command   json.RawMessage `json:"command,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type sessionEntry struct {
	id        string
	cmd       string
	risk      Risk
	canonical string
	sha256    string
	status    CommandStatus
	by        string
	expiresAt int64
	timer     *time.Timer
	order     int // creation order, for deterministic voiding
}

type SessionOptions struct {
	Idle           time.Duration
	CommandMax     int
	CommandTimeout time.Duration
	ApprovalTTL    time.Duration
	Now            func() int64 // Unix milliseconds
	// Send writes one line to the guest. It may fail.
	Send func(line string) error
	// Emit stores and publishes a command event.
	Emit func(ev CommandEvent)
	// Abort ends the whole run with this reason.
	Abort func(e *RunError)
}

// CmdError is a refused command, approval or rejection. Code is what the HTTP layer maps to a status.
type CmdError struct {
	Code string
	Msg  string
}

func (e *CmdError) Error() string { return e.Code + ": " + e.Msg }

// SubmitOK is the answer to an accepted command.
type SubmitOK struct {
	CommandID string        `json:"command_id"`
	Status    CommandStatus `json:"status"`
	SHA256    string        `json:"command_sha256"`
}

type sessionPhase string

const (
	phaseStarting sessionPhase = "starting"
	phaseReady    sessionPhase = "ready"
	phaseClosing  sessionPhase = "closing"
	phaseEnded    sessionPhase = "ended"
)

type SessionCommands struct {
	mu        sync.Mutex
	o         SessionOptions
	phase     sessionPhase
	entries   map[string]*sessionEntry
	queue     []string
	inflight  *sessionEntry
	cmdTimer  *time.Timer
	idleTimer *time.Timer
	idleGen   int
	userTotal int
	nextOrder int
}

func NewSessionCommands(o SessionOptions) *SessionCommands {
	return &SessionCommands{o: o, phase: phaseStarting, entries: map[string]*sessionEntry{}}
}

func (s *SessionCommands) Phase() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.phase)
}

type CommandCounts struct {
	Total            int `json:"total"`
	AwaitingApproval int `json:"awaiting_approval"`
}

func (s *SessionCommands) Counts() CommandCounts {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, e := range s.entries {
		if e.status == CmdAwaitingApproval {
			n++
		}
	}
	return CommandCounts{Total: s.userTotal, AwaitingApproval: n}
}

// MarkReady is called when the collector says session_ready. It is true only the first time.
func (s *SessionCommands) MarkReady() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase != phaseStarting {
		return false
	}
	s.phase = phaseReady
	s.refreshIdle()
	return true
}

func (s *SessionCommands) Submit(raw any) (SubmitOK, *CmdError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase != phaseReady {
		return SubmitOK{}, &CmdError{"not_session", "the run is not in a session that accepts commands"}
	}
	c, problem := ValidateCommand(raw)
	if problem != "" {
		return SubmitOK{}, &CmdError{"bad_command", problem}
	}
	if _, dup := s.entries[c.ID]; dup {
		return SubmitOK{}, &CmdError{"duplicate_id", "a command with this id already exists in the run"}
	}
	if s.userTotal >= s.o.CommandMax {
		return SubmitOK{}, &CmdError{"limit", "too many commands in this run"}
	}

	s.userTotal++
	e := &sessionEntry{id: c.ID, cmd: c.Cmd, risk: c.Risk, canonical: c.Canonical, sha256: c.SHA256, status: CmdAccepted, by: "client", order: s.nextOrder}
	s.nextOrder++
	s.entries[e.id] = e
	s.publish(e, json.RawMessage(e.canonical), "")
	if e.risk == RiskRisky {
		e.status = CmdAwaitingApproval
		e.expiresAt = s.o.Now() + s.o.ApprovalTTL.Milliseconds()
		e.timer = time.AfterFunc(s.o.ApprovalTTL, func() { s.expireFromTimer(e) })
		s.publish(e, nil, "")
	} else {
		s.queue = append(s.queue, e.id)
	}
	s.refreshIdle()
	s.drain()
	status := e.status
	if status == CmdSent {
		status = CmdAccepted
	}
	return SubmitOK{CommandID: e.id, Status: status, SHA256: e.sha256}, nil
}

func (s *SessionCommands) Approve(commandID string, sha256 any) *CmdError {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase != phaseReady {
		return &CmdError{"not_session", "the run is not in a session that accepts approvals"}
	}
	e, ok := s.entries[commandID]
	if !ok {
		return &CmdError{"not_found", "no such command"}
	}
	if e.status == CmdExpired {
		return &CmdError{"expired", "the approval period has passed"}
	}
	if e.status != CmdAwaitingApproval {
		return &CmdError{"not_waiting", fmt.Sprintf("the command is not waiting for approval (%s)", e.status)}
	}
	if e.expiresAt != 0 && s.o.Now() >= e.expiresAt {
		s.expire(e)
		return &CmdError{"expired", "the approval period has passed"}
	}
	// the digest must be that of the exact command received; a wrong one leaves the command waiting
	if !SameDigest(sha256, e.sha256) {
		return &CmdError{"hash_mismatch", "command_sha256 does not match the command"}
	}
	s.clearEntryTimer(e)
	e.status = CmdApproved
	s.publish(e, nil, "")
	s.queue = append(s.queue, e.id) // behind everything already queued, not at the place it was received
	s.drain()
	return nil
}

func (s *SessionCommands) Reject(commandID string) *CmdError {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[commandID]
	if !ok {
		return &CmdError{"not_found", "no such command"}
	}
	if e.status != CmdAwaitingApproval && e.status != CmdAccepted && e.status != CmdApproved {
		return &CmdError{"too_late", fmt.Sprintf("the command can no longer be rejected (%s)", e.status)}
	}
	s.clearEntryTimer(e)
	for i, id := range s.queue {
		if id == e.id {
			s.queue = append(s.queue[:i], s.queue[i+1:]...)
			break
		}
	}
	e.status = CmdRejected
	s.publish(e, nil, "")
	s.refreshIdle()
	return nil
}

// OnResult is a cmd_result line from the guest. Only the command in flight can be answered; anything else is ignored.
func (s *SessionCommands) OnResult(commandID string, ok bool, errorCode string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.inflight
	if s.phase == phaseEnded || e == nil || e.id != commandID {
		return false
	}
	s.clearCmdTimer()
	s.inflight = nil
	if ok {
		e.status = CmdDone
		s.publish(e, nil, "")
	} else {
		e.status = CmdErrored
		if errorCode == "" {
			errorCode = "unknown"
		}
		s.publish(e, nil, errorCode)
	}
	s.drain()
	s.refreshIdle()
	return true
}

// End is called when the session is over (the collector exited or the run is being torn down): nothing can be sent any
// more, and what is still open is voided.
func (s *SessionCommands) End() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phase == phaseEnded {
		return
	}
	s.phase = phaseEnded
	s.clearCmdTimer()
	s.clearIdle()
	// publish in the order the commands were made, not in map order
	for _, e := range s.sortedEntries() {
		s.clearEntryTimer(e)
		if !IsOpenStatus(string(e.status)) {
			continue
		}
		// a close that was sent has done its job once the collector is gone
		if e.cmd == "close" && e.status == CmdSent {
			e.status = CmdDone
		} else {
			e.status = CmdVoided
		}
		s.publish(e, nil, "")
	}
	s.queue = nil
	s.inflight = nil
}

// ---- internals; the lock is held --------------------------------------------------------------------------

func (s *SessionCommands) sortedEntries() []*sessionEntry {
	out := make([]*sessionEntry, 0, len(s.entries))
	for _, e := range s.entries {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].order < out[j].order })
	return out
}

func (s *SessionCommands) publish(e *sessionEntry, command json.RawMessage, errCode string) {
	ev := CommandEvent{CommandID: e.id, Cmd: e.cmd, Status: e.status, Risk: e.risk, SHA256: e.sha256, Command: command, Error: errCode}
	if e.by == "supervisor" {
		ev.By = "supervisor"
	}
	s.o.Emit(ev)
}

func (s *SessionCommands) clearEntryTimer(e *sessionEntry) {
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
}

func (s *SessionCommands) clearCmdTimer() {
	if s.cmdTimer != nil {
		s.cmdTimer.Stop()
		s.cmdTimer = nil
	}
}

func (s *SessionCommands) expireFromTimer(e *sessionEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire(e)
}

func (s *SessionCommands) expire(e *sessionEntry) {
	if e.status != CmdAwaitingApproval || s.phase == phaseEnded {
		return
	}
	s.clearEntryTimer(e)
	e.status = CmdExpired
	s.publish(e, nil, "")
	s.refreshIdle()
}

// drain sends the next queued command if none is in flight. One at a time, in order.
func (s *SessionCommands) drain() {
	if s.phase != phaseReady || s.inflight != nil {
		return
	}
	var e *sessionEntry
	for len(s.queue) > 0 {
		next := s.entries[s.queue[0]]
		s.queue = s.queue[1:]
		if next != nil && (next.status == CmdAccepted || next.status == CmdApproved) {
			e = next
			break
		}
	}
	if e == nil {
		return
	}
	e.status = CmdSent
	s.inflight = e
	if e.cmd == "close" {
		s.phase = phaseClosing
	}
	s.publish(e, nil, "")
	s.clearIdle()
	s.cmdTimer = time.AfterFunc(s.o.CommandTimeout, func() { s.commandTimedOut(e) })
	if err := s.o.Send(e.canonical); err != nil {
		s.clearCmdTimer()
		s.o.Abort(newRunError(ReasonAgentError, "command could not be sent: "+err.Error()))
	}
}

func (s *SessionCommands) commandTimedOut(e *sessionEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight != e {
		return
	}
	e.status = CmdTimeout
	s.publish(e, nil, "")
	s.inflight = nil
	s.o.Abort(newRunError(ReasonTimeout, "the collector did not answer a command in time"))
}

func (s *SessionCommands) clearIdle() {
	s.idleGen++ // a timer that has already fired but not yet taken the lock sees a new generation and gives up
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
}

// refreshIdle runs the idle clock only while nothing is queued, in flight or waiting for a human: time spent waiting
// for an approval is not idle time (the total time limit still applies).
func (s *SessionCommands) refreshIdle() {
	s.clearIdle()
	if s.phase != phaseReady || s.inflight != nil || len(s.queue) > 0 {
		return
	}
	for _, e := range s.entries {
		if e.status == CmdAwaitingApproval {
			return
		}
	}
	gen := s.idleGen
	s.idleTimer = time.AfterFunc(s.o.Idle, func() { s.idleExpired(gen) })
}

// idleExpired closes the session with a normal close command from the supervisor itself.
func (s *SessionCommands) idleExpired(gen int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if gen != s.idleGen || s.phase != phaseReady {
		return
	}
	s.idleTimer = nil
	id := "idle-close"
	for {
		if _, taken := s.entries[id]; !taken {
			break
		}
		id += "_"
	}
	canonical, _ := CanonicalJSON(map[string]any{"cmd": "close", "id": id})
	e := &sessionEntry{id: id, cmd: "close", risk: RiskSafe, canonical: canonical, sha256: sha256Hex(canonical), status: CmdAccepted, by: "supervisor", order: s.nextOrder}
	s.nextOrder++
	s.entries[id] = e
	s.publish(e, nil, "")
	s.queue = append(s.queue, id)
	s.drain()
}
