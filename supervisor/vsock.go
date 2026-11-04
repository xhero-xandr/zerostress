package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sync"
	"time"
)

var handshakeRe = regexp.MustCompile(`^OK \d+$`)

// agentConn is an open stream to the guest agent: the Unix socket of Firecracker's vsock proxy after a successful
// "CONNECT <port>" handshake. Firecracker closes the connection at once when nothing listens in the guest.
type agentConn struct {
	conn net.Conn
	br   *bufio.Reader // bytes that arrived together with the handshake reply are already in here
}

// connectAgent dials the socket, sends "CONNECT <port>" and expects "OK <n>". It honours ctx and the timeout.
func connectAgent(ctx context.Context, uds string, port int, timeout time.Duration) (*agentConn, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "unix", uds)
	if err != nil {
		return nil, ctxOr(ctx, err) // a cancelled run reports its cause, not the dial error
	}
	// the context closes the connection, which unblocks any read or write below
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	fail := func(err error) (*agentConn, error) {
		stop()
		_ = conn.Close()
		if ctx.Err() != nil {
			return nil, context.Cause(ctx)
		}
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", port); err != nil {
		return fail(err)
	}
	br := bufio.NewReaderSize(conn, 64*1024)
	line, err := br.ReadSlice('\n')
	if err != nil {
		if errors.Is(err, bufio.ErrBufferFull) {
			return fail(errors.New("handshake reply too long"))
		}
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return fail(errors.New("handshake timeout"))
		}
		return fail(errors.New("closed before handshake"))
	}
	first := string(line[:len(line)-1])
	if !handshakeRe.MatchString(first) {
		return fail(fmt.Errorf("handshake refused: %s", clip(first, 40)))
	}
	_ = conn.SetDeadline(time.Time{})
	if !stop() {
		// the context was cancelled between the handshake and now; the connection is already closed
		return nil, context.Cause(ctx)
	}
	return &agentConn{conn: conn, br: br}, nil
}

// probeAgent is true when the guest agent accepts a connection (it is closed again without sending a job).
func probeAgent(ctx context.Context, uds string, port int) bool {
	c, err := connectAgent(ctx, uds, port, time.Second)
	if err != nil {
		return false
	}
	_ = c.conn.Close()
	return true
}

// agentStream sends one job line and delivers every complete line the agent streams back, until the connection closes.
// It never half-closes (EOF would make the agent kill the job). A trailing partial line is dropped. Further lines
// (session commands) go through Write.
type agentStream struct {
	c  *agentConn
	mu sync.Mutex // serialises writes
	// closed is set once the stream has ended
	closed bool
}

// runAgentJob returns nil when the connection ended (close or reset: the caller decides from the last line whether the
// job finished) and an error on handshake failure, an over-long line or cancellation. onOpen, if given, receives the
// writer for further lines as soon as the job has been sent.
func runAgentJob(ctx context.Context, uds string, port int, job string, onLine func(string), maxLine int, onOpen func(write func(string) error)) error {
	c, err := connectAgent(ctx, uds, port, 2*time.Second)
	if err != nil {
		return err
	}
	st := &agentStream{c: c}
	stop := context.AfterFunc(ctx, func() { _ = c.conn.Close() })
	defer func() {
		stop()
		st.mu.Lock()
		st.closed = true
		st.mu.Unlock()
		_ = c.conn.Close()
	}()

	if err := st.write(job); err != nil {
		return ctxOr(ctx, err)
	}
	if onOpen != nil {
		onOpen(st.write)
	}
	var line []byte
	for {
		chunk, err := c.br.ReadSlice('\n')
		line = append(line, chunk...)
		switch {
		case err == nil:
			onLine(string(line[:len(line)-1]))
			line = line[:0]
		case errors.Is(err, bufio.ErrBufferFull):
			if len(line) > maxLine {
				return errors.New("line too long")
			}
		default:
			// EOF or a reset ends the stream; the caller looks at the last line
			if ctx.Err() != nil {
				return context.Cause(ctx)
			}
			return nil
		}
	}
}

func (s *agentStream) write(line string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("the agent connection is closed")
	}
	_ = s.c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := s.c.conn.Write([]byte(line + "\n"))
	return err
}

func ctxOr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	return err
}
