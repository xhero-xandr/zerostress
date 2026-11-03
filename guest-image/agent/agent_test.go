package main

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func testConfig(script string) Config {
	return Config{
		Cmd:            []string{"/bin/sh", "-c", script},
		Timeout:        5 * time.Second,
		MaxOut:         1 << 20,
		MaxJob:         1024,
		ReadJobTimeout: 500 * time.Millisecond,
		Env:            []string{"PATH=/usr/bin:/bin"},
	}
}

// serve starts the agent on a unix socket and returns a dial function.
func serve(t *testing.T, cfg Config) (*Agent, func() net.Conn) {
	t.Helper()
	ag, err := NewAgent(cfg)
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(t.TempDir(), "a.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go ag.Handle(c)
		}
	}()
	return ag, func() net.Conn {
		c, err := net.Dial("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
}

func readLines(t *testing.T, c net.Conn) []string {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	b, err := io.ReadAll(c)
	if err != nil {
		t.Fatalf("read: %v (got %q)", err, b)
	}
	s := strings.TrimSuffix(string(b), "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func lastStatus(t *testing.T, lines []string) status {
	t.Helper()
	if len(lines) == 0 {
		t.Fatal("no output")
	}
	var st status
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &st); err != nil || st.Type != "status" {
		t.Fatalf("last line is not a status: %q", lines[len(lines)-1])
	}
	return st
}

func runJob(t *testing.T, cfg Config, job string) ([]string, status) {
	t.Helper()
	_, dial := serve(t, cfg)
	c := dial()
	defer c.Close()
	if _, err := c.Write([]byte(job + "\n")); err != nil {
		t.Fatal(err)
	}
	lines := readLines(t, c)
	return lines, lastStatus(t, lines)
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitDead(t *testing.T, pid int) {
	t.Helper()
	for i := 0; i < 40; i++ {
		if !alive(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("process %d still alive", pid)
}

func TestOkEchoesJobAndStatus(t *testing.T) {
	lines, st := runJob(t, testConfig("cat"), `{"url":"http://x"}`)
	if st.Status != "ok" || st.ExitCode == nil || *st.ExitCode != 0 {
		t.Fatalf("status = %+v", st)
	}
	if len(lines) != 2 || lines[0] != `{"url":"http://x"}` {
		t.Fatalf("lines = %q", lines)
	}
}

func TestExitedNonzero(t *testing.T) {
	_, st := runJob(t, testConfig(`echo '{"e":1}'; echo boom >&2; exit 3`), `{}`)
	if st.Status != "exited_nonzero" || st.ExitCode == nil || *st.ExitCode != 3 {
		t.Fatalf("status = %+v", st)
	}
	if !strings.Contains(st.StderrTail, "boom") {
		t.Fatalf("stderr tail = %q", st.StderrTail)
	}
}

func TestStatusOnOwnLineWhenOutputHasNoNewline(t *testing.T) {
	lines, st := runJob(t, testConfig(`printf '{"x":1}'`), `{}`)
	if st.Status != "ok" || len(lines) != 2 || lines[0] != `{"x":1}` {
		t.Fatalf("lines = %q", lines)
	}
}

func TestCollectorCannotForgeFinalStatus(t *testing.T) {
	// The collector prints a fake "ok" status; the real status still comes last.
	lines, st := runJob(t, testConfig(`echo '{"type":"status","status":"ok"}'; exit 7`), `{}`)
	if st.Status != "exited_nonzero" || len(lines) != 2 {
		t.Fatalf("lines = %q", lines)
	}
}

func TestOversizeIsCappedAndKilled(t *testing.T) {
	cfg := testConfig(`yes '{"a":1}'`)
	cfg.MaxOut = 1000
	lines, st := runJob(t, cfg, `{}`)
	if st.Status != "oversize" {
		t.Fatalf("status = %+v", st)
	}
	total := 0
	for _, l := range lines[:len(lines)-1] {
		total += len(l) + 1
	}
	if total > 1000 {
		t.Fatalf("forwarded %d bytes, cap 1000", total)
	}
}

func TestTimeoutKillsWholeProcessGroup(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	cfg := testConfig(`sleep 60 & echo $! > ` + pidfile + `; wait`)
	cfg.Timeout = 400 * time.Millisecond
	begin := time.Now()
	_, st := runJob(t, cfg, `{}`)
	if st.Status != "timeout" {
		t.Fatalf("status = %+v", st)
	}
	if time.Since(begin) > 4*time.Second {
		t.Fatalf("took %v", time.Since(begin))
	}
	b, err := os.ReadFile(pidfile)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	waitDead(t, pid)
}

func TestClientGoneKillsJob(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	ag, dial := serve(t, testConfig(`echo $$ > `+pidfile+`; sleep 60`))
	c := dial()
	if _, err := c.Write([]byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	var pid int
	for i := 0; i < 40 && pid == 0; i++ {
		if b, err := os.ReadFile(pidfile); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		}
		time.Sleep(50 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("job did not start")
	}
	c.Close()
	waitDead(t, pid)
	for i := 0; i < 40 && ag.busy.Load(); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if ag.busy.Load() {
		t.Fatal("agent still busy after client left")
	}
}

func TestBusyWhileJobRuns(t *testing.T) {
	_, dial := serve(t, testConfig(`sleep 2`))
	c1 := dial()
	defer c1.Close()
	if _, err := c1.Write([]byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	c2 := dial()
	defer c2.Close()
	_, _ = c2.Write([]byte(`{"mode":"hello"}` + "\n")) // a real client sends its job right away
	begin := time.Now()
	st := lastStatus(t, readLines(t, c2))
	if st.Status != "busy" || time.Since(begin) > time.Second {
		t.Fatalf("status = %+v after %v", st, time.Since(begin))
	}
}

func TestBadJobs(t *testing.T) {
	cases := map[string]string{
		"not json":      "hello",
		"json array":    "[1,2]",
		"empty":         "",
		"oversize line": `{"a":"` + strings.Repeat("x", 2000) + `"}`,
	}
	for name, job := range cases {
		t.Run(name, func(t *testing.T) {
			_, st := runJob(t, testConfig("cat"), job)
			if st.Status != "bad_job" {
				t.Fatalf("status = %+v", st)
			}
		})
	}
}

func TestNoNewlineTimesOut(t *testing.T) {
	_, dial := serve(t, testConfig("cat"))
	c := dial()
	defer c.Close()
	if _, err := c.Write([]byte(`{"a":1}`)); err != nil { // no newline
		t.Fatal(err)
	}
	st := lastStatus(t, readLines(t, c))
	if st.Status != "bad_job" {
		t.Fatalf("status = %+v", st)
	}
}

func TestStartFailed(t *testing.T) {
	cfg := testConfig("")
	cfg.Cmd = []string{"/nonexistent/collector"}
	_, st := runJob(t, cfg, `{}`)
	if st.Status != "start_failed" {
		t.Fatalf("status = %+v", st)
	}
}

func TestMinimalEnvironment(t *testing.T) {
	t.Setenv("ZEROSTRESS_SECRET", "leak")
	lines, st := runJob(t, testConfig(`env`), `{}`)
	if st.Status != "ok" {
		t.Fatalf("status = %+v", st)
	}
	for _, l := range lines {
		if strings.Contains(l, "ZEROSTRESS_SECRET") {
			t.Fatal("agent environment leaked into the collector")
		}
	}
}
