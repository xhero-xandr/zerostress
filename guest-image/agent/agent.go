// Command zerostress-agent is the guest-side job receiver.
//
// Contract (client = supervisor on the host):
//  1. Client connects and sends ONE line: a JSON object, at most MaxJob bytes. It must not half-close
//     its write side afterwards: EOF from the client is treated as "client gone" and kills the job.
//  2. Agent runs the collector (job on stdin) and streams its stdout to the client unchanged,
//     capped at MaxOut bytes.
//  3. Agent writes ONE final line: {"type":"status",...}. A newline is inserted first if the
//     collector output did not end with one, so the status is always on its own line.
//  4. Agent closes the connection. One job at a time; a concurrent connection gets "busy".
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os/exec"
	"os/user"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type Config struct {
	Cmd            []string
	User           string // run the collector as this user; empty = no switch (tests)
	Timeout        time.Duration
	MaxOut         int64
	MaxJob         int
	ReadJobTimeout time.Duration
	Env            []string
}

type Agent struct {
	cfg  Config
	busy atomic.Bool
	cred *syscall.Credential
}

type status struct {
	Type       string `json:"type"`
	Status     string `json:"status"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	StderrTail string `json:"stderr_tail,omitempty"`
	DurationMs int64  `json:"duration_ms"`
}

const (
	reasonNone int32 = iota
	reasonOversize
	reasonGone
)

const stderrTailBytes = 2048

func NewAgent(cfg Config) (*Agent, error) {
	if len(cfg.Cmd) == 0 {
		return nil, errors.New("empty collector command")
	}
	a := &Agent{cfg: cfg}
	if cfg.User != "" {
		u, err := user.Lookup(cfg.User)
		if err != nil {
			return nil, err
		}
		uid, err := strconv.ParseUint(u.Uid, 10, 32)
		if err != nil {
			return nil, err
		}
		gid, err := strconv.ParseUint(u.Gid, 10, 32)
		if err != nil {
			return nil, err
		}
		a.cred = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{}}
	}
	return a, nil
}

func (a *Agent) Handle(conn net.Conn) {
	defer conn.Close()
	// Read the job first, and only then claim the slot: a readiness probe (connect, no job, close) must not make
	// the real job that follows it a moment later fail with "busy".
	job, err := a.readJob(conn)
	if err != nil {
		reject(conn, "bad_job")
		return
	}
	if !a.busy.CompareAndSwap(false, true) {
		reject(conn, "busy")
		return
	}
	defer a.busy.Store(false)
	st, needNL := a.run(conn, job)
	log.Printf("job finished: status=%s duration_ms=%d", st.Status, st.DurationMs)
	if st.Status != "client_gone" {
		writeStatus(conn, st, needNL)
	}
}

func (a *Agent) readJob(conn net.Conn) ([]byte, error) {
	_ = conn.SetReadDeadline(time.Now().Add(a.cfg.ReadJobTimeout))
	defer conn.SetReadDeadline(time.Time{})
	br := bufio.NewReaderSize(io.LimitReader(conn, int64(a.cfg.MaxJob)+1), 4096)
	line, err := br.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	body := bytes.TrimSpace(line)
	if len(body) == 0 || body[0] != '{' || !json.Valid(body) {
		return nil, errors.New("job is not a JSON object")
	}
	return append(body, '\n'), nil
}

func (a *Agent) run(conn net.Conn, job []byte) (status, bool) {
	start := time.Now()
	st := status{Type: "status"}
	finish := func(s string) (status, bool) {
		st.Status = s
		st.DurationMs = time.Since(start).Milliseconds()
		return st, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), a.cfg.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, a.cfg.Cmd[0], a.cfg.Cmd[1:]...)
	cmd.Env = a.cfg.Env
	cmd.Stdin = bytes.NewReader(job)
	stderr := &tailBuf{max: stderrTailBytes}
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: a.cred}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.StdoutPipe()
	if err != nil {
		st.StderrTail = err.Error()
		return finish("start_failed")
	}
	if err := cmd.Start(); err != nil {
		st.StderrTail = err.Error()
		return finish("start_failed")
	}
	pgid := cmd.Process.Pid

	var reason atomic.Int32
	stop := func(r int32) {
		if reason.CompareAndSwap(reasonNone, r) {
			cancel()
		}
	}
	// A read returning means the client closed (or errored): kill the job.
	go func() {
		n, err := io.Copy(io.Discard, conn)
		log.Printf("client side ended: extra_bytes=%d err=%v", n, err)
		stop(reasonGone)
	}()

	var written int64
	last := byte('\n')
	buf := make([]byte, 32<<10)
	for {
		n, rerr := out.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			over := false
			if left := a.cfg.MaxOut - written; int64(len(chunk)) > left {
				chunk = chunk[:left]
				over = true
			}
			if len(chunk) > 0 {
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if _, werr := conn.Write(chunk); werr != nil {
					log.Printf("write failed after %d bytes: %v", written, werr)
					stop(reasonGone)
					break
				}
				written += int64(len(chunk))
				last = chunk[len(chunk)-1]
			}
			if over {
				stop(reasonOversize)
				break
			}
		}
		if rerr != nil {
			break
		}
	}

	werr := cmd.Wait()
	_ = syscall.Kill(-pgid, syscall.SIGKILL) // stragglers in the same process group
	st.StderrTail = stderr.String()
	needNL := last != '\n'

	var code int
	switch reason.Load() {
	case reasonOversize:
		s, _ := finish("oversize")
		return s, needNL
	case reasonGone:
		s, _ := finish("client_gone")
		return s, needNL
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		s, _ := finish("timeout")
		return s, needNL
	}
	if werr == nil {
		code = 0
		st.ExitCode = &code
		s, _ := finish("ok")
		return s, needNL
	}
	code = -1
	var ee *exec.ExitError
	if errors.As(werr, &ee) {
		code = ee.ExitCode()
	}
	st.ExitCode = &code
	s, _ := finish("exited_nonzero")
	return s, needNL
}

// reject answers with a status and swallows what the client still sends: closing with unread input
// would reset the connection and the status line could be lost.
func reject(conn net.Conn, s string) {
	writeStatus(conn, status{Type: "status", Status: s}, false)
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, _ = io.Copy(io.Discard, io.LimitReader(conn, 1<<20))
}

func writeStatus(conn net.Conn, st status, needNL bool) {
	b, err := json.Marshal(st)
	if err != nil {
		b = []byte(fmt.Sprintf(`{"type":"status","status":%q}`, st.Status))
	}
	var msg []byte
	if needNL {
		msg = append(msg, '\n')
	}
	msg = append(msg, b...)
	msg = append(msg, '\n')
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Write(msg)
}

type tailBuf struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuf) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = append([]byte(nil), t.b[len(t.b)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailBuf) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}
