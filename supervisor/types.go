package main

import (
	"context"
	"errors"
	"io"
	"time"
)

type RunState string

const (
	StateQueued     RunState = "queued"
	StatePreparing  RunState = "preparing"
	StateBooting    RunState = "booting"
	StateRunning    RunState = "running"
	StateSession    RunState = "session"
	StateDestroying RunState = "destroying"
	StateDone       RunState = "done"
	StateFailed     RunState = "failed"
)

func (s RunState) Terminal() bool { return s == StateDone || s == StateFailed }

type FailReason string

const (
	ReasonQueueTimeout      FailReason = "queue_timeout"
	ReasonCancelled         FailReason = "cancelled"
	ReasonNetSetup          FailReason = "net_setup"
	ReasonDiskCopy          FailReason = "disk_copy"
	ReasonFcAPI             FailReason = "fc_api"
	ReasonFcCrashed         FailReason = "fc_crashed"
	ReasonBootTimeout       FailReason = "boot_timeout"
	ReasonTimeout           FailReason = "timeout"
	ReasonOversize          FailReason = "oversize"
	ReasonCollectorFailed   FailReason = "collector_failed"
	ReasonAgentError        FailReason = "agent_error"
	ReasonSupervisorRestart FailReason = "supervisor_restart"
	ReasonInternal          FailReason = "internal"
)

// RunError carries the failure reason of a run. It is also the cancellation cause of a run's context.
type RunError struct {
	Reason FailReason
	Msg    string
}

func (e *RunError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	return string(e.Reason)
}

func newRunError(reason FailReason, msg string) *RunError { return &RunError{Reason: reason, Msg: msg} }

// asRunError turns any error into a RunError, keeping the reason of one that already is.
func asRunError(err error, fallback FailReason) *RunError {
	var re *RunError
	if errors.As(err, &re) {
		return re
	}
	return &RunError{Reason: fallback, Msg: err.Error()}
}

// causeOf is the reason a context ended: the RunError it was cancelled with, or a plain context error.
func causeOf(ctx context.Context, fallback FailReason) *RunError {
	c := context.Cause(ctx)
	if c == nil {
		return newRunError(fallback, "")
	}
	return asRunError(c, fallback)
}

// SessionLimits are the limits of an interactive session.
type SessionLimits struct {
	IdleMs int64 `json:"idle_ms"`
	MaxMs  int64 `json:"max_ms"`
}

// RunRecord is the stored state of one run. Times are Unix milliseconds.
type RunRecord struct {
	ID          string         `json:"id"`
	URL         string         `json:"url"`
	State       RunState       `json:"state"`
	Reason      FailReason     `json:"reason,omitempty"`
	Slot        *int           `json:"slot,omitempty"`
	CreatedAt   int64          `json:"created_at"`
	StartedAt   *int64         `json:"started_at,omitempty"`
	FinishedAt  *int64         `json:"finished_at,omitempty"`
	AgentStatus string         `json:"agent_status,omitempty"`
	Partial     bool           `json:"partial,omitempty"`
	Events      int            `json:"events"`
	ExpiresAt   int64          `json:"expires_at"`
	Session     *SessionLimits `json:"session,omitempty"`
	// VMCPU is the processor time the microVM used, measured by the host (cpu.go); nil when it could not be read.
	VMCPU *VMCPU `json:"vm_cpu,omitempty"`
	// Seq orders runs that were created in the same millisecond.
	Seq int64 `json:"seq"`
}

// RunEvent is a stored event. Data is a single-line string: JSON for state, status and command events, the raw guest
// line for evidence.
type RunEvent struct {
	Seq  int    `json:"seq"`
	Type string `json:"type"`
	Data string `json:"data"`
}

type StartOptions struct {
	RunID  string
	RunDir string
	Slot   int
	VCPU   int
	MemMiB int
}

// VM is one running microVM. Every method is safe to call after the VM has died.
type VM interface {
	// WaitReady returns when the guest agent accepts connections; it fails with boot_timeout or fc_crashed.
	WaitReady(ctx context.Context, timeout time.Duration) error
	// RunJob sends the job line and streams guest lines until the connection closes. It never half-closes. onLine is
	// called from the calling goroutine only. Commands go through Send.
	RunJob(ctx context.Context, job string, onLine func(string)) error
	// Send writes one more line to the open agent connection (session commands).
	Send(line string) error
	// FetchArtifact copies the named artifact from the guest into dst, at most max bytes (spec 005, 3.6). It uses its
	// own connection, so it works while a job or session is running.
	FetchArtifact(ctx context.Context, name string, dst io.Writer, max int64) (int64, error)
	// Exited is closed when the Firecracker process is gone, for any reason.
	Exited() <-chan struct{}
	// Stop ends the VM (SIGTERM, then SIGKILL after a short grace) and returns when it is gone.
	Stop()
	// Gone reports whether the VM's unit is really over. Stop gives up after its timeouts on a unit that does not
	// end (a process stuck in the kernel); its slot must not go to the next VM before Gone, since every VM of a slot
	// runs as the slot's user (review E).
	Gone() bool
	// CPUUsage is the processor time the VM's unit has used so far, from systemd's accounting of its cgroup: read by the
	// host, so a guest cannot say otherwise. false when it cannot be read.
	CPUUsage() (time.Duration, bool)
	// Console returns the last bytes of the VM console (diagnostics only, untrusted).
	Console() string
}

// Backend is everything the supervisor core needs from the host. The real one is backend.go, tests use a fake.
type Backend interface {
	PrepareDisk(ctx context.Context, runDir string) error
	NetUp(ctx context.Context, slot int, runID string) error
	// NetDown is idempotent. It is called for every slot that NetUp was attempted on, whatever happened since.
	NetDown(ctx context.Context, slot int, runID string) error
	Start(ctx context.Context, opts StartOptions) (VM, error)
	RemoveRunDir(runDir string) error
	// RecoverHost kills stray Firecracker processes, runs zsnet down for all slots and removes leftover run dirs.
	RecoverHost(ctx context.Context) error
}
