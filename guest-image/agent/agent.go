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
//
// Protocol v2 (sessions, spec 005/006): if the job has a "session" object, the collector's stdin stays open and
// every further client line is forwarded to it as a command. The agent checks only the form of a command (a JSON
// object of at most MaxCmd bytes, at most MaxCmds per job); anything else ends the job with status "bad_command".
// The collector's wall-clock limit for a session is session.max_s (capped by SessionMax) plus SessionGrace.
// For a job without "session" the client's extra lines are discarded, as in v1.
//
// Artifact hand-over (spec 005, 3.6): a connection whose first line is {"op":"artifact","name":...} is not a job. It
// is served from the artifact directory while a job runs and does not take the job slot (artifact.go).
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
	// protocol v2 (zero values get defaults in NewAgent)
	SessionMax   time.Duration // upper bound for session.max_s
	SessionGrace time.Duration // added on top of max_s before the agent kills the collector
	MaxCmd       int           // bytes per command line
	MaxCmds      int           // commands per job
	// artifact hand-over (artifact.go)
	ArtifactDir string
	MaxArtifact int64
}

type Agent struct {
	cfg     Config
	busy    atomic.Bool
	readers atomic.Int32 // open artifact hand-overs
	cred    *syscall.Credential
}

type status struct {
	Type       string `json:"type"`
	Status     string `json:"status"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	StderrTail string `json:"stderr_tail,omitempty"`
	Commands   int    `json:"commands,omitempty"`
	DurationMs int64  `json:"duration_ms"`
}

const (
	reasonNone int32 = iota
	reasonOversize
	reasonGone
	reasonBadCommand
)

const stderrTailBytes = 2048

func NewAgent(cfg Config) (*Agent, error) {
	if len(cfg.Cmd) == 0 {
		return nil, errors.New("empty collector command")
	}
	if cfg.SessionMax == 0 {
		cfg.SessionMax = 600 * time.Second
	}
	if cfg.SessionGrace == 0 {
		cfg.SessionGrace = 30 * time.Second
	}
	if cfg.MaxCmd == 0 {
		cfg.MaxCmd = 4096
	}
	if cfg.MaxCmds == 0 {
		cfg.MaxCmds = 200
	}
	if cfg.ArtifactDir == "" {
		cfg.ArtifactDir = defaultArtifactDir
	}
	if cfg.MaxArtifact == 0 {
		cfg.MaxArtifact = defaultMaxArtifact
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

// session describes the optional "session" object of a job.
type session struct {
	on   bool
	maxS float64
}

// parseSession is strict: a "session" of the wrong type makes the whole job bad.
func parseSession(job []byte) (session, error) {
	var j struct {
		Session *struct {
			MaxS *float64 `json:"max_s"`
		} `json:"session"`
	}
	if err := json.Unmarshal(job, &j); err != nil {
		return session{}, err
	}
	if j.Session == nil {
		return session{}, nil
	}
	m := 300.0
	if j.Session.MaxS != nil {
		m = *j.Session.MaxS
	}
	if m < 1 {
		m = 1
	}
	return session{on: true, maxS: m}, nil
}

func (a *Agent) Handle(conn net.Conn) {
	defer conn.Close()
	// One buffered reader for the whole connection: a second reader would lose commands that arrive right behind
	// the job line. Its buffer must hold the longest line we accept (job or command).
	size := a.cfg.MaxJob
	if a.cfg.MaxCmd > size {
		size = a.cfg.MaxCmd
	}
	br := bufio.NewReaderSize(conn, size+2)

	// Read the job first, and only then claim the slot: a readiness probe (connect, no job, close) must not make
	// the real job that follows it a moment later fail with "busy".
	job, err := a.readJob(conn, br)
	if err != nil {
		reject(conn, "bad_job")
		return
	}
	// A hand-over request is not a job: it must not take the job slot, and it is served while a session is running.
	var req artifactRequest
	if json.Unmarshal(job, &req) == nil && req.Op != "" {
		if req.Op != "artifact" {
			reject(conn, "bad_job")
			return
		}
		a.serveArtifact(conn, req.Name)
		return
	}
	sess, err := parseSession(job)
	if err != nil {
		reject(conn, "bad_job")
		return
	}
	if !a.busy.CompareAndSwap(false, true) {
		reject(conn, "busy")
		return
	}
	defer a.busy.Store(false)
	st, needNL := a.run(conn, br, job, sess)
	log.Printf("job finished: status=%s duration_ms=%d session=%v commands=%d", st.Status, st.DurationMs, sess.on, st.Commands)
	if st.Status != "client_gone" {
		writeStatus(conn, st, needNL)
		if st.Status == "bad_command" {
			// the rest of the offending line may still be on its way: closing with unread input would reset the
			// connection and could lose the status line (the reader goroutine has already returned)
			_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
			_, _ = io.Copy(io.Discard, io.LimitReader(br, 1<<20))
		}
	}
}

func (a *Agent) readJob(conn net.Conn, br *bufio.Reader) ([]byte, error) {
	_ = conn.SetReadDeadline(time.Now().Add(a.cfg.ReadJobTimeout))
	defer conn.SetReadDeadline(time.Time{})
	line, err := br.ReadSlice('\n') // bufio.ErrBufferFull: longer than anything we accept
	if err != nil {
		return nil, err
	}
	body := bytes.TrimSpace(line)
	if len(body) == 0 || len(body) > a.cfg.MaxJob || body[0] != '{' || !json.Valid(body) {
		return nil, errors.New("job is not a JSON object of acceptable size")
	}
	return append(append([]byte(nil), body...), '\n'), nil // copy: the slice belongs to the reader's buffer
}

func (a *Agent) run(conn net.Conn, br *bufio.Reader, job []byte, sess session) (status, bool) {
	start := time.Now()
	st := status{Type: "status"}
	var forwarded atomic.Int32
	finish := func(s string) (status, bool) {
		st.Status = s
		st.Commands = int(forwarded.Load())
		st.DurationMs = time.Since(start).Milliseconds()
		return st, false
	}

	timeout := a.cfg.Timeout
	if sess.on {
		s := time.Duration(sess.maxS * float64(time.Second))
		if s > a.cfg.SessionMax {
			s = a.cfg.SessionMax
		}
		timeout = s + a.cfg.SessionGrace
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, a.cfg.Cmd[0], a.cfg.Cmd[1:]...)
	cmd.Env = a.cfg.Env
	var stdin io.WriteCloser
	if sess.on {
		var err error
		if stdin, err = cmd.StdinPipe(); err != nil {
			st.StderrTail = err.Error()
			return finish("start_failed")
		}
	} else {
		cmd.Stdin = bytes.NewReader(job)
	}
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

	// Lines for the collector's stdin: the job first, then commands, written in order by one goroutine. It never
	// closes the channel (the reader may still send); it ends with the context.
	lines := make(chan []byte, 16)
	if sess.on {
		lines <- job
		go func() {
			broken := false
			for {
				select {
				case l := <-lines:
					if broken {
						continue
					}
					if _, err := stdin.Write(l); err != nil {
						broken = true // the collector has gone; keep draining so the reader never blocks
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// The client's side of the connection. A read that returns means the client closed or errored: kill the job.
	go func() {
		if !sess.on {
			n, err := io.Copy(io.Discard, br)
			log.Printf("client side ended: extra_bytes=%d err=%v", n, err)
			stop(reasonGone)
			return
		}
		count := 0
		for {
			line, err := br.ReadSlice('\n')
			if err != nil {
				if errors.Is(err, bufio.ErrBufferFull) {
					log.Printf("command line too long")
					stop(reasonBadCommand)
				} else {
					log.Printf("client side ended: err=%v commands=%d", err, count)
					stop(reasonGone)
				}
				return
			}
			body := bytes.TrimSpace(line)
			if len(body) == 0 {
				continue
			}
			if len(body) > a.cfg.MaxCmd || body[0] != '{' || !json.Valid(body) {
				log.Printf("bad command line (%d bytes)", len(body))
				stop(reasonBadCommand)
				return
			}
			count++
			if count > a.cfg.MaxCmds {
				log.Printf("too many commands")
				stop(reasonBadCommand)
				return
			}
			forwarded.Store(int32(count))
			cp := append(append([]byte(nil), body...), '\n')
			select {
			case lines <- cp:
			default: // commands are sent one at a time, so a full queue means a misbehaving client
				stop(reasonBadCommand)
				return
			}
		}
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
	case reasonBadCommand:
		s, _ := finish("bad_command")
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
