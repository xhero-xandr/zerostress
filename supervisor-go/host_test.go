package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// ---- fakes ---------------------------------------------------------------------------------------------------

func hostTSock(t testing.TB, name string) string { return filepath.Join(t.TempDir(), name+".sock") }

// hostTListen serves a Unix socket; handle runs once per connection. Everything is closed when the test ends.
func hostTListen(t testing.TB, path string, handle func(c net.Conn)) {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				handle(c)
			}()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		for _, c := range conns {
			_ = c.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
}

// hostTReadLine reads one line a byte at a time, so nothing after it is consumed from the socket.
func hostTReadLine(c net.Conn) (string, error) {
	var line []byte
	b := make([]byte, 1)
	for len(line) < 1<<20 {
		if _, err := c.Read(b); err != nil {
			return "", err
		}
		if b[0] == '\n' {
			return string(line), nil
		}
		line = append(line, b[0])
	}
	return "", errors.New("line too long")
}

var hostTConnectRe = regexp.MustCompile(`^CONNECT \d+$`)

// hostTProxy emulates Firecracker's vsock proxy: "CONNECT <port>" -> "OK <n>", then whatever agent does with the job
// line. With refuse the connection is closed at once (nothing listens in the guest).
func hostTProxy(t testing.TB, agent func(job string, c net.Conn), refuse bool) string {
	t.Helper()
	path := hostTSock(t, "p")
	hostTListen(t, path, func(c net.Conn) {
		if refuse {
			_ = c.Close()
			return
		}
		line, err := hostTReadLine(c)
		if err != nil {
			return
		}
		if !hostTConnectRe.MatchString(line) {
			t.Errorf("handshake request = %q", line)
			return
		}
		if _, err := c.Write([]byte("OK 1073741824\n")); err != nil {
			return
		}
		job, err := hostTReadLine(c)
		if err != nil {
			return
		}
		agent(job, c)
	})
	return path
}

type hostTCall struct{ Method, Path, ContentType, Body string }

type hostTFC struct {
	mu    sync.Mutex
	calls []hostTCall
}

func (f *hostTFC) Calls() []hostTCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hostTCall(nil), f.calls...)
}

// hostTFirecracker emulates the Firecracker API: it records every call and answers 204 unless behave answers itself.
func hostTFirecracker(t testing.TB, behave func(w http.ResponseWriter, r *http.Request) bool) (string, *hostTFC) {
	t.Helper()
	path := hostTSock(t, "fc")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	rec := &hostTFC{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.calls = append(rec.calls, hostTCall{r.Method, r.URL.Path, r.Header.Get("Content-Type"), string(b)})
		rec.mu.Unlock()
		if behave != nil && behave(w, r) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return path, rec
}

func hostTCtx(t testing.TB, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

func hostTRunError(t testing.TB, err error, reason FailReason) *RunError {
	t.Helper()
	var re *RunError
	if !errors.As(err, &re) || re.Reason != reason {
		t.Fatalf("error = %v (%T), want a RunError %s", err, err, reason)
	}
	return re
}

// ---- vsock: lines --------------------------------------------------------------------------------------------

func TestHost_RunAgentJob_SendsTheJobStreamsLinesInOrderEndsWhenTheAgentCloses(t *testing.T) {
	jobs := make(chan string, 1)
	path := hostTProxy(t, func(job string, c net.Conn) {
		jobs <- job
		_, _ = c.Write([]byte("{\"e\":1}\n{\"e\":2}\n{\"type\":\"status\",\"status\":\"ok\"}\n"))
		_ = c.Close()
	}, false)
	var lines []string
	err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, `{"kind":"url"}`, func(l string) { lines = append(lines, l) }, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{`{"e":1}`, `{"e":2}`, `{"type":"status","status":"ok"}`}; !reflect.DeepEqual(lines, want) {
		t.Errorf("lines = %q", lines)
	}
	if job := <-jobs; job != `{"kind":"url"}` {
		t.Errorf("job = %q", job)
	}
}

func TestHost_RunAgentJob_LinesAcrossChunksAndMultiByteCharactersAcrossChunkBorders(t *testing.T) {
	payload := []byte("{\"t\":\"привет\"}\n{\"t\":2}\n")
	path := hostTProxy(t, func(_ string, c net.Conn) {
		for i := 0; i < len(payload); i += 3 {
			end := min(i+3, len(payload))
			if _, err := c.Write(payload[i:end]); err != nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
		_ = c.Close()
	}, false)
	var lines []string
	if err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "{}", func(l string) { lines = append(lines, l) }, 100, nil); err != nil {
		t.Fatal(err)
	}
	if want := []string{`{"t":"привет"}`, `{"t":2}`}; !reflect.DeepEqual(lines, want) {
		t.Errorf("lines = %q", lines)
	}
}

func TestHost_RunAgentJob_LineLongerThanTheReadBufferComesOutIntact(t *testing.T) {
	long := strings.Repeat("a", 200000)
	path := hostTProxy(t, func(_ string, c net.Conn) {
		_, _ = c.Write([]byte(long + "\nnext\n"))
		_ = c.Close()
	}, false)
	var lines []string
	if err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "{}", func(l string) { lines = append(lines, l) }, 1<<20, nil); err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0] != long || lines[1] != "next" {
		t.Errorf("got %d lines, first has %d bytes", len(lines), len(lines[0]))
	}
}

func TestHost_RunAgentJob_TrailingPartialLineIsDroppedAndAResetStillEndsTheStream(t *testing.T) {
	for _, reset := range []bool{false, true} {
		name := "close"
		if reset {
			name = "reset"
		}
		t.Run(name, func(t *testing.T) {
			path := hostTProxy(t, func(_ string, c net.Conn) {
				_, _ = c.Write([]byte("{\"e\":1}\n{\"e\":2"))
				// a connection closed with unread data is reset on Linux; the client's extra line stays unread
				time.Sleep(100 * time.Millisecond)
				_ = c.Close()
			}, false)
			var lines []string
			onOpen := func(w func(string) error) {
				if reset {
					_ = w("unread")
				}
			}
			err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "{}", func(l string) { lines = append(lines, l) }, 1000, onOpen)
			if err != nil {
				t.Fatalf("the end of the stream must not be an error: %v", err)
			}
			if !reflect.DeepEqual(lines, []string{`{"e":1}`}) {
				t.Errorf("lines = %q", lines)
			}
		})
	}
}

func TestHost_RunAgentJob_OverLongLineIsAnError(t *testing.T) {
	// The Go reader checks the cap whenever its 64 KiB buffer fills, so the line must be longer than that; the
	// production cap is 2 MiB.
	path := hostTProxy(t, func(_ string, c net.Conn) {
		_, _ = c.Write([]byte(strings.Repeat("x", 70000)))
		_, _ = io.Copy(io.Discard, c)
	}, false)
	err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "{}", func(string) {}, 1000, nil)
	if err == nil || !strings.Contains(err.Error(), "line too long") {
		t.Fatalf("err = %v", err)
	}
}

func TestHost_RunAgentJob_LinesUnderTheCapAreNotAnError(t *testing.T) {
	// control for the test above: the same stream with a cap above its length is fine
	path := hostTProxy(t, func(_ string, c net.Conn) {
		_, _ = c.Write([]byte(strings.Repeat("x", 70000) + "\n"))
		_ = c.Close()
	}, false)
	var lines []string
	err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "{}", func(l string) { lines = append(lines, l) }, 100000, nil)
	if err != nil || len(lines) != 1 || len(lines[0]) != 70000 {
		t.Fatalf("err = %v, lines = %d", err, len(lines))
	}
}

// ---- vsock: the job and the writer ---------------------------------------------------------------------------

func TestHost_RunAgentJob_JobIsSentOnceAndTheStreamIsNeverHalfClosed(t *testing.T) {
	type seen struct {
		job   string
		extra string
		eof   bool
	}
	res := make(chan seen, 1)
	path := hostTProxy(t, func(job string, c net.Conn) {
		s := seen{job: job}
		buf := make([]byte, 64)
		_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		for {
			n, err := c.Read(buf)
			s.extra += string(buf[:n])
			if err != nil {
				s.eof = errors.Is(err, io.EOF)
				break
			}
		}
		_ = c.SetReadDeadline(time.Time{})
		_, _ = c.Write([]byte("{\"e\":1}\n"))
		_ = c.Close()
		res <- s
	}, false)
	var lines []string
	if err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "J1", func(l string) { lines = append(lines, l) }, 1000, nil); err != nil {
		t.Fatal(err)
	}
	s := <-res
	if s.job != "J1" || s.extra != "" {
		t.Errorf("job = %q, extra bytes after it = %q", s.job, s.extra)
	}
	if s.eof {
		t.Error("the client half-closed the connection; the agent would kill the job")
	}
	if !reflect.DeepEqual(lines, []string{`{"e":1}`}) {
		t.Errorf("lines = %q", lines)
	}
}

func TestHost_RunAgentJob_WriterDeliversCommandLinesAndFailsAfterTheStreamEnded(t *testing.T) {
	jobs := make(chan string, 1)
	path := hostTProxy(t, func(job string, c net.Conn) {
		jobs <- job
		for {
			line, err := hostTReadLine(c)
			if err != nil {
				return
			}
			if line == "bye" {
				_, _ = c.Write([]byte("{\"echo\":\"bye\"}\n"))
				_ = c.Close()
				return
			}
			_, _ = c.Write([]byte("echo:" + line + "\n"))
		}
	}, false)
	var write func(string) error
	var lines []string
	err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "job", func(l string) { lines = append(lines, l) }, 1000, func(w func(string) error) {
		write = w
		for _, l := range []string{"cmd1", "cmd2", "bye"} {
			if err := w(l); err != nil {
				t.Errorf("write %s: %v", l, err)
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"echo:cmd1", "echo:cmd2", `{"echo":"bye"}`}; !reflect.DeepEqual(lines, want) {
		t.Errorf("lines = %q", lines)
	}
	if job := <-jobs; job != "job" {
		t.Errorf("job = %q", job)
	}
	if err := write("late"); err == nil || err.Error() != "the agent connection is closed" {
		t.Errorf("write after the end = %v", err)
	}
}

func TestHost_RunAgentJob_WritesRacingWithTheEndOfTheStreamFailCleanly(t *testing.T) {
	path := hostTProxy(t, func(_ string, c net.Conn) {
		_, _ = hostTReadLine(c)
		_ = c.Close()
	}, false)
	done := make(chan error, 1)
	err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "job", func(string) {}, 1000, func(w func(string) error) {
		go func() {
			for i := 0; i < 100000; i++ {
				if err := w("x"); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}()
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case werr := <-done:
		if werr == nil {
			t.Error("writes never failed after the stream ended")
		}
	case <-time.After(5 * time.Second):
		t.Error("the writer neither finished nor failed")
	}
}

func TestHost_RunAgentJob_ConcurrentWritesStayWholeLines(t *testing.T) {
	lineRe := regexp.MustCompile(`^g\d-\d+-x{1000}$`)
	path := hostTProxy(t, func(_ string, c net.Conn) {
		br := bufio.NewReader(c)
		for n := 0; n < 100; n++ {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if !lineRe.MatchString(strings.TrimSuffix(line, "\n")) {
				_, _ = c.Write([]byte("bad\n"))
				_ = c.Close()
				return
			}
		}
		_, _ = c.Write([]byte("all-ok\n"))
		_ = c.Close()
	}, false)
	var wg sync.WaitGroup
	var lines []string
	err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "job", func(l string) { lines = append(lines, l) }, 1000, func(w func(string) error) {
		for g := 0; g < 4; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 25; i++ {
					_ = w(fmt.Sprintf("g%d-%d-%s", g, i, strings.Repeat("x", 1000)))
				}
			}()
		}
	})
	wg.Wait()
	if err != nil || !reflect.DeepEqual(lines, []string{"all-ok"}) {
		t.Fatalf("err = %v, lines = %q", err, lines)
	}
}

// ---- vsock: cancellation -------------------------------------------------------------------------------------

func TestHost_RunAgentJob_CancelClosesTheConnectionAndReturnsTheCause(t *testing.T) {
	closed := make(chan struct{})
	path := hostTProxy(t, func(_ string, c net.Conn) { // never answers
		_, _ = io.Copy(io.Discard, c)
		close(closed)
	}, false)
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	time.AfterFunc(50*time.Millisecond, func() { cancel(newRunError(ReasonCancelled, "")) })
	start := time.Now()
	err := runAgentJob(ctx, path, 5000, "{}", func(string) {}, 1000, nil)
	hostTRunError(t, err, ReasonCancelled)
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("took %v", d)
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Error("the connection was not closed")
	}
}

func TestHost_ConnectAgent_CancelDuringTheHandshakeReturnsTheCause(t *testing.T) {
	path := hostTSock(t, "hs")
	hostTListen(t, path, func(c net.Conn) { _, _ = io.Copy(io.Discard, c) }) // accepts, never replies
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	time.AfterFunc(50*time.Millisecond, func() { cancel(newRunError(ReasonCancelled, "")) })
	start := time.Now()
	_, err := connectAgent(ctx, path, 5000, 10*time.Second)
	hostTRunError(t, err, ReasonCancelled)
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("took %v, the handshake timeout must not be waited for", d)
	}
}

func TestHost_RunAgentJob_AlreadyCancelledContextReturnsTheCause(t *testing.T) {
	path := hostTProxy(t, func(_ string, c net.Conn) { _, _ = io.Copy(io.Discard, c) }, false)
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(newRunError(ReasonCancelled, ""))
	err := runAgentJob(ctx, path, 5000, "{}", func(string) {}, 1000, nil)
	hostTRunError(t, err, ReasonCancelled)
}

// ---- vsock: handshake ----------------------------------------------------------------------------------------

func TestHost_ConnectAgent_Handshake(t *testing.T) {
	cases := []struct {
		name    string
		reply   string
		refused bool
	}{
		{"ok", "OK 1073741824\n", false},
		{"ok small", "OK 0\n", false},
		{"nope", "NOPE\n", true},
		{"no number", "OK\n", true},
		{"letters", "OK abc\n", true},
		{"lower case", "ok 1\n", true},
		{"trailing space", "OK 1 \n", true},
		{"carriage return", "OK 1\r\n", true},
		{"empty line", "\n", true},
		{"extra words", "OK 1 2\n", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := hostTSock(t, "hs")
			hostTListen(t, path, func(conn net.Conn) {
				if _, err := hostTReadLine(conn); err != nil {
					return
				}
				_, _ = conn.Write([]byte(c.reply))
				_, _ = io.Copy(io.Discard, conn)
			})
			conn, err := connectAgent(hostTCtx(t, 5*time.Second), path, 5000, time.Second)
			if conn != nil {
				_ = conn.conn.Close()
			}
			if c.refused {
				if err == nil || !strings.Contains(err.Error(), "handshake refused") {
					t.Fatalf("err = %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHost_ConnectAgent_SendsConnectWithThePort(t *testing.T) {
	got := make(chan string, 1)
	path := hostTSock(t, "hs")
	hostTListen(t, path, func(c net.Conn) {
		line, _ := hostTReadLine(c)
		got <- line
		_, _ = c.Write([]byte("OK 5\n"))
		_, _ = io.Copy(io.Discard, c)
	})
	conn, err := connectAgent(hostTCtx(t, 5*time.Second), path, 4321, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.conn.Close()
	if line := <-got; line != "CONNECT 4321" {
		t.Errorf("request = %q", line)
	}
}

func TestHost_ConnectAgent_RefusedReplyIsClippedInTheMessage(t *testing.T) {
	path := hostTSock(t, "hs")
	hostTListen(t, path, func(c net.Conn) {
		_, _ = hostTReadLine(c)
		_, _ = c.Write([]byte(strings.Repeat("X", 100) + "\n"))
		_, _ = io.Copy(io.Discard, c)
	})
	_, err := connectAgent(hostTCtx(t, 5*time.Second), path, 5000, time.Second)
	if err == nil || !strings.Contains(err.Error(), "handshake refused: "+strings.Repeat("X", 40)) || strings.Contains(err.Error(), strings.Repeat("X", 41)) {
		t.Fatalf("err = %v", err)
	}
}

func TestHost_ConnectAgent_ClosedBeforeTheReplyIsAnError(t *testing.T) {
	path := hostTProxy(t, nil, true)
	_, err := connectAgent(hostTCtx(t, 5*time.Second), path, 5000, time.Second)
	// the CONNECT write can lose the race with the close and fail with a broken pipe instead
	if err == nil || !regexp.MustCompile(`closed before handshake|broken pipe|reset by peer`).MatchString(err.Error()) {
		t.Fatalf("err = %v", err)
	}
	err = runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "{}", func(string) {}, 1000, nil)
	if err == nil {
		t.Fatal("runAgentJob must fail when the proxy closes at once")
	}
}

func TestHost_ConnectAgent_ReplyThatNeverEndsIsAnError(t *testing.T) {
	path := hostTSock(t, "hs")
	hostTListen(t, path, func(c net.Conn) {
		_, _ = hostTReadLine(c)
		_, _ = c.Write([]byte(strings.Repeat("x", 70000)))
		_, _ = io.Copy(io.Discard, c)
	})
	_, err := connectAgent(hostTCtx(t, 5*time.Second), path, 5000, 3*time.Second)
	if err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("err = %v", err)
	}
}

func TestHost_ConnectAgent_SilentPeerHitsTheHandshakeTimeout(t *testing.T) {
	path := hostTSock(t, "hs")
	hostTListen(t, path, func(c net.Conn) { _, _ = io.Copy(io.Discard, c) })
	start := time.Now()
	_, err := connectAgent(hostTCtx(t, 10*time.Second), path, 5000, 200*time.Millisecond)
	if err == nil {
		t.Fatal("no error")
	}
	if d := time.Since(start); d < 150*time.Millisecond || d > 3*time.Second {
		t.Errorf("gave up after %v", d)
	}
}

func TestHost_ConnectAgent_SlowReplyWithinTheTimeoutIsAccepted(t *testing.T) {
	path := hostTSock(t, "hs")
	hostTListen(t, path, func(c net.Conn) {
		_, _ = hostTReadLine(c)
		time.Sleep(150 * time.Millisecond)
		_, _ = c.Write([]byte("OK 1\n"))
		_, _ = io.Copy(io.Discard, c)
	})
	conn, err := connectAgent(hostTCtx(t, 10*time.Second), path, 5000, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.conn.Close()
}

func TestHost_ConnectAgent_NothingListeningIsAnError(t *testing.T) {
	_, err := connectAgent(hostTCtx(t, 5*time.Second), hostTSock(t, "none"), 5000, time.Second)
	if err == nil {
		t.Fatal("no error")
	}
}

func TestHost_RunAgentJob_BytesThatArriveWithTheHandshakeReplyAreNotLost(t *testing.T) {
	cases := []struct {
		name   string
		first  string // written in the same write as the reply
		second string // written after the job line arrived
		want   []string
	}{
		{"whole lines", "{\"e\":1}\n{\"e\":2}\n", "", []string{`{"e":1}`, `{"e":2}`}},
		{"line completed later", "{\"e\":", "1}\n", []string{`{"e":1}`}},
		{"lines on both sides", "{\"e\":1}\n{\"e\"", ":2}\n{\"e\":3}\n", []string{`{"e":1}`, `{"e":2}`, `{"e":3}`}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := hostTSock(t, "hs")
			hostTListen(t, path, func(conn net.Conn) {
				if _, err := hostTReadLine(conn); err != nil {
					return
				}
				_, _ = conn.Write([]byte("OK 1\n" + c.first))
				if _, err := hostTReadLine(conn); err != nil {
					return
				}
				_, _ = conn.Write([]byte(c.second))
				_ = conn.Close()
			})
			var lines []string
			if err := runAgentJob(hostTCtx(t, 5*time.Second), path, 5000, "{}", func(l string) { lines = append(lines, l) }, 1000, nil); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(lines, c.want) {
				t.Errorf("lines = %q, want %q", lines, c.want)
			}
		})
	}
}

func TestHost_ProbeAgent(t *testing.T) {
	ok := hostTProxy(t, func(string, net.Conn) {}, false)
	refuse := hostTProxy(t, nil, true)
	ctx := hostTCtx(t, 10*time.Second)
	if !probeAgent(ctx, ok, 5000) {
		t.Error("an agent that answers must probe true")
	}
	if probeAgent(ctx, refuse, 5000) {
		t.Error("Firecracker closing at once must probe false")
	}
	if probeAgent(ctx, hostTSock(t, "missing"), 5000) {
		t.Error("a missing socket must probe false")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if probeAgent(cancelled, ok, 5000) {
		t.Error("a cancelled context must probe false")
	}
}

// ---- firecracker ---------------------------------------------------------------------------------------------

func TestHost_FcPut_204OKAnythingElseIsAnFcAPIErrorCarryingTheReply(t *testing.T) {
	path, rec := hostTFirecracker(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/boot-source" {
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"fault_message":"bad value"}`))
		return true
	})
	ctx := hostTCtx(t, 10*time.Second)
	if err := fcPut(ctx, path, "/machine-config", `{"vcpu_count":2,"mem_size_mib":1024}`); err != nil {
		t.Fatal(err)
	}
	err := fcPut(ctx, path, "/boot-source", `{"x":1}`)
	re := hostTRunError(t, err, ReasonFcAPI)
	if !strings.Contains(re.Msg, "bad value") || !strings.Contains(re.Msg, "400") || !strings.Contains(re.Msg, "/boot-source") {
		t.Errorf("message = %q", re.Msg)
	}
	calls := rec.Calls()
	want := []hostTCall{
		{"PUT", "/machine-config", "application/json", `{"vcpu_count":2,"mem_size_mib":1024}`},
		{"PUT", "/boot-source", "application/json", `{"x":1}`},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Errorf("calls = %+v", calls)
	}
}

func TestHost_FcPut_OtherSuccessCodesAndLongRepliesAreErrors(t *testing.T) {
	path, _ := hostTFirecracker(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/ok200" {
			w.WriteHeader(200)
			return true
		}
		w.WriteHeader(500)
		_, _ = w.Write([]byte(strings.Repeat("e", 1000)))
		return true
	})
	ctx := hostTCtx(t, 10*time.Second)
	hostTRunError(t, fcPut(ctx, path, "/ok200", `{}`), ReasonFcAPI)
	re := hostTRunError(t, fcPut(ctx, path, "/big", `{}`), ReasonFcAPI)
	if !strings.Contains(re.Msg, strings.Repeat("e", 200)) || strings.Contains(re.Msg, strings.Repeat("e", 201)) {
		t.Errorf("the reply must be cut at 200 bytes, message has %d bytes", len(re.Msg))
	}
}

func TestHost_FcPut_UnreachableSocketIsAnFcAPIError(t *testing.T) {
	err := fcPut(hostTCtx(t, 10*time.Second), hostTSock(t, "absent"), "/x", `{}`)
	re := hostTRunError(t, err, ReasonFcAPI)
	if !strings.Contains(re.Msg, "/x") {
		t.Errorf("message = %q", re.Msg)
	}
}

func TestHost_FcPut_TimeoutIsAnFcAPIError(t *testing.T) {
	path, _ := hostTFirecracker(t, func(w http.ResponseWriter, r *http.Request) bool {
		select { // never answers
		case <-r.Context().Done():
		case <-time.After(20 * time.Second):
		}
		return true
	})
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	err := fcPut(ctx, path, "/actions", `{"action_type":"InstanceStart"}`)
	hostTRunError(t, err, ReasonFcAPI)
	if d := time.Since(start); d < 150*time.Millisecond || d > 4*time.Second {
		t.Errorf("gave up after %v", d)
	}
}

func TestHost_BootArgsAndMACFollowTheSlot(t *testing.T) {
	bootWant := []string{
		"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off:1.1.1.1",
		"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.1.2::172.16.1.1:255.255.255.252::eth0:off:1.1.1.1",
		"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.2.2::172.16.2.1:255.255.255.252::eth0:off:1.1.1.1",
		"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.3.2::172.16.3.1:255.255.255.252::eth0:off:1.1.1.1",
	}
	macWant := []string{"06:00:AC:10:00:02", "06:00:AC:10:01:02", "06:00:AC:10:02:02", "06:00:AC:10:03:02"}
	for slot := 0; slot <= 3; slot++ {
		if got := bootArgs(slot); got != bootWant[slot] {
			t.Errorf("bootArgs(%d) = %q", slot, got)
		}
		if got := guestMAC(slot); got != macWant[slot] {
			t.Errorf("guestMAC(%d) = %q", slot, got)
		}
	}
}

// launchFirecracker starts the VM through "sudo zsvm run", which a test must not do, so the six configuration calls
// (order and bodies) cannot be checked from here; fcPut and the boot arguments above are the testable parts.

func TestHost_RingBufferKeepsTheLastBytes(t *testing.T) {
	var r ringBuffer
	_, _ = r.Write([]byte("short"))
	if r.String() != "short" {
		t.Fatalf("got %q", r.String())
	}
	var all strings.Builder
	all.WriteString("short")
	for i := 0; i < 40; i++ {
		chunk := fmt.Sprintf("%02d", i) + strings.Repeat("-", 3000)
		n, err := r.Write([]byte(chunk))
		if n != len(chunk) || err != nil {
			t.Fatalf("Write = %d, %v", n, err)
		}
		all.WriteString(chunk)
	}
	got := r.String()
	if len(got) != consoleKeep || got != all.String()[all.Len()-consoleKeep:] {
		t.Errorf("kept %d bytes, want the last %d", len(got), consoleKeep)
	}
	if tail("abcdef", 3) != "def" || tail("ab", 3) != "ab" {
		t.Error("tail")
	}
}

// ---- backend helpers -----------------------------------------------------------------------------------------

func TestHost_SlotArgRange(t *testing.T) {
	for slot := 0; slot <= 3; slot++ {
		if got, err := slotArg(slot); err != nil || got != fmt.Sprint(slot) {
			t.Errorf("slotArg(%d) = %q, %v", slot, got, err)
		}
	}
	for _, slot := range []int{-1, 4, 100} {
		if got, err := slotArg(slot); err == nil || got != "" || !strings.Contains(err.Error(), fmt.Sprint(slot)) {
			t.Errorf("slotArg(%d) = %q, %v", slot, got, err)
		}
	}
}

func TestHost_NetUpAndDownRefuseASlotOutOfRangeBeforeRunningAnything(t *testing.T) {
	b := NewLinuxBackend(makeConfig(t, t.TempDir(), nil), nil)
	for _, slot := range []int{-1, 4} {
		err := b.NetUp(context.Background(), slot, "")
		re := hostTRunError(t, err, ReasonNetSetup)
		if !strings.Contains(re.Msg, "invalid slot") {
			t.Errorf("NetUp(%d) = %v", slot, err)
		}
		if err := b.NetDown(context.Background(), slot, ""); err == nil || !strings.Contains(err.Error(), "invalid slot") {
			t.Errorf("NetDown(%d) = %v", slot, err)
		}
	}
}

func TestHost_FreeGBOf(t *testing.T) {
	dir := t.TempDir()
	got := freeGBOf(dir)()
	if got <= 0 {
		t.Errorf("free space of a temp dir = %v", got)
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		t.Fatal(err)
	}
	avail := float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
	if math.Abs(got-avail) > 0.5 {
		t.Errorf("free space = %.2f GB, statfs says %.2f GB available to non-root users", got, avail)
	}
	if got := freeGBOf(filepath.Join(t.TempDir(), "missing"))(); got != 0 {
		t.Errorf("free space of a missing path = %v, want 0 (refuse work rather than guess)", got)
	}
}

func TestHost_ImageSHAFrom(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	cases := []struct {
		name     string
		manifest *string
		want     string
	}{
		{"present", ptr(`{"image":{"sha256":"` + sha + `"},"other":1}`), sha},
		{"missing", nil, ""},
		{"damaged", ptr(`{"image":{"sha256":`), ""},
		{"not an object", ptr(`[1,2]`), ""},
		{"no image section", ptr(`{"kernel":{}}`), ""},
		{"no sha", ptr(`{"image":{}}`), ""},
		{"sha not a string", ptr(`{"image":{"sha256":5}}`), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			if c.manifest != nil {
				if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(*c.manifest), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if got := imageSHAFrom(dir)(); got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestHost_ImageSHAFrom_IsReadOnceAndCached(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(path, []byte(`{"image":{"sha256":"first"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	get := imageSHAFrom(dir)
	if get() != "first" {
		t.Fatal("first read")
	}
	if err := os.WriteFile(path, []byte(`{"image":{"sha256":"second"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := get(); got != "first" {
		t.Errorf("after the file changed: %q, want the cached value", got)
	}
}

func TestHost_RunUsesACleanEnvironmentAndReportsStderr(t *testing.T) {
	for _, p := range []string{"/usr/bin/env", "/bin/sh"} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("%s not available", p)
		}
	}
	t.Setenv("ZEROSTRESS_TEST_SECRET", "must-not-leak")
	out, err := run(hostTCtx(t, 10*time.Second), 5*time.Second, "/usr/bin/env")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "PATH=/usr/bin:/bin" {
		t.Errorf("environment of the child = %q", out)
	}
	_, err = run(hostTCtx(t, 10*time.Second), 5*time.Second, "/bin/sh", "-c", "echo boom >&2; exit 3")
	if err == nil || err.Error() != "boom" {
		t.Errorf("failure = %v, want the stderr text", err)
	}
	start := time.Now()
	if _, err = run(hostTCtx(t, 10*time.Second), 200*time.Millisecond, "/bin/sh", "-c", "sleep 5"); err == nil {
		t.Error("a command over its timeout must fail")
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("the timeout took %v", time.Since(start))
	}
}

func TestHost_PrepareDiskCopiesTheImageAndRemoveRunDirDeletesIt(t *testing.T) {
	if _, err := os.Stat("/usr/bin/cp"); err != nil {
		t.Skip("/usr/bin/cp not available")
	}
	dir := t.TempDir()
	image := filepath.Join(dir, "guest-rootfs.ext4")
	content := append([]byte("ext4-image-"), make([]byte, 1<<20)...)
	content = append(content, []byte("-end")...)
	if err := os.WriteFile(image, content, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := makeConfig(t, dir, func(c *Config) { c.ImagePath = image })
	b := NewLinuxBackend(cfg, nil)
	runDir := filepath.Join(dir, "runs", "r1")
	ctx := hostTCtx(t, 30*time.Second)

	if err := b.PrepareDisk(ctx, runDir); err != nil {
		t.Fatal(err)
	}
	disk := filepath.Join(runDir, "rootfs.ext4")
	got, err := os.ReadFile(disk)
	if err != nil || string(got) != string(content) {
		t.Fatalf("the copy differs from the image (err %v, %d bytes)", err, len(got))
	}
	st, _ := os.Stat(disk)
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && sys.Blocks*512 > st.Size()/2 {
		t.Errorf("the copy is not sparse: %d bytes allocated for %d", sys.Blocks*512, st.Size())
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("disk mode = %v, want 0600", st.Mode().Perm())
	}
	if rst, _ := os.Stat(runDir); rst.Mode().Perm() != 0o700 {
		t.Errorf("run dir mode = %v, want 0700", rst.Mode().Perm())
	}
	// the run owns its copy: writing to it leaves the image alone
	if err := os.WriteFile(disk, []byte("scribble"), 0o600); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(image); string(after) != string(content) {
		t.Error("the image was changed through the copy")
	}

	if err := b.RemoveRunDir(runDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(runDir); !os.IsNotExist(err) {
		t.Errorf("run dir still there: %v", err)
	}
	if err := b.RemoveRunDir(runDir); err != nil {
		t.Errorf("removing a missing dir = %v, want nil", err)
	}
}

func TestHost_PrepareDiskFailsWithDiskCopyWhenTheImageIsMissing(t *testing.T) {
	if _, err := os.Stat("/usr/bin/cp"); err != nil {
		t.Skip("/usr/bin/cp not available")
	}
	dir := t.TempDir()
	cfg := makeConfig(t, dir, func(c *Config) { c.ImagePath = filepath.Join(dir, "absent.ext4") })
	err := NewLinuxBackend(cfg, nil).PrepareDisk(hostTCtx(t, 30*time.Second), filepath.Join(dir, "runs", "r2"))
	hostTRunError(t, err, ReasonDiskCopy)
}

// stdioSocket must give a connected pair: what the child writes to its end is read from the parent's end, and the
// parent sees end-of-file once the child's end is closed. (That the pair is a socket and not a pipe is the point: see
// launchFirecracker. Only a real run on the host proves systemd-run accepts it; deploy/test/supervisor-e2e.sh does.)
func TestHost_StdioSocketIsAConnectedPair(t *testing.T) {
	parent, child, err := stdioSocket()
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	if _, err := child.Write([]byte("hello console\n")); err != nil {
		t.Fatal(err)
	}
	child.Close()
	b, err := io.ReadAll(parent)
	if err != nil || string(b) != "hello console\n" {
		t.Fatalf("read %q, %v", b, err)
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(int(parent.Fd()), &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
		t.Fatalf("not a socket: mode %o, %v", st.Mode, err)
	}
}
