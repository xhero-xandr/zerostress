package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const sessionJob = `{"schema":1,"kind":"url","url":"https://x.test/","session":{"idle_s":60,"max_s":30}}`

func sessionConfig(script string) Config {
	cfg := testConfig(script)
	cfg.SessionGrace = 300 * time.Millisecond
	return cfg
}

// sendSession writes the job and then every command (pausing a little between them, as a real client does) and
// returns what the agent streamed back until it closed the connection.
func sendSession(t *testing.T, cfg Config, job string, cmds ...string) ([]string, status) {
	t.Helper()
	_, dial := serve(t, cfg)
	c := dial()
	defer c.Close()
	if _, err := c.Write([]byte(job + "\n")); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range cmds {
		time.Sleep(80 * time.Millisecond)
		_, _ = c.Write([]byte(cmd + "\n")) // the agent may already be gone: that is checked through the status
	}
	lines := readLines(t, c)
	return lines, lastStatus(t, lines)
}

func TestSessionCommandsReachTheCollectorInOrder(t *testing.T) {
	cfg := sessionConfig(`read job; echo "job:$job"; read c1; echo "c1:$c1"; read c2; echo "c2:$c2"`)
	lines, st := sendSession(t, cfg, sessionJob, `{"cmd":"scroll","id":"a","dy":100}`, `{"cmd":"close","id":"b"}`)
	if st.Status != "ok" || st.Commands != 2 {
		t.Fatalf("status = %+v, lines = %q", st, lines)
	}
	if len(lines) != 4 || !strings.HasPrefix(lines[0], "job:") || !strings.Contains(lines[0], `"session"`) ||
		lines[1] != `c1:{"cmd":"scroll","id":"a","dy":100}` || lines[2] != `c2:{"cmd":"close","id":"b"}` {
		t.Fatalf("lines = %q", lines)
	}
}

func TestPipelinedCommandsAreNotLost(t *testing.T) {
	cfg := sessionConfig(`read job; read c1; echo "c1:$c1"; read c2; echo "c2:$c2"`)
	_, dial := serve(t, cfg)
	c := dial()
	defer c.Close()
	// job and two commands in ONE write: a second buffered reader behind the job reader would swallow them
	if _, err := c.Write([]byte(sessionJob + "\n" + `{"cmd":"wait","id":"1","ms":10}` + "\n" + `{"cmd":"wait","id":"2","ms":20}` + "\n")); err != nil {
		t.Fatal(err)
	}
	lines := readLines(t, c)
	st := lastStatus(t, lines)
	if st.Status != "ok" || st.Commands != 2 || len(lines) != 3 || !strings.HasPrefix(lines[0], "c1:") || !strings.HasPrefix(lines[1], "c2:") {
		t.Fatalf("status = %+v, lines = %q", st, lines)
	}
}

func TestBlankLinesBetweenCommandsAreIgnored(t *testing.T) {
	cfg := sessionConfig(`read job; read c1; echo "c1:$c1"`)
	_, st := sendSession(t, cfg, sessionJob, ``, `   `, `{"cmd":"wait","id":"1","ms":1}`)
	if st.Status != "ok" || st.Commands != 1 {
		t.Fatalf("status = %+v", st)
	}
}

func TestJobWithoutSessionKeepsV1Behaviour(t *testing.T) {
	// stdin is closed after the job and extra client lines are discarded, not forwarded
	lines, st := sendSession(t, testConfig("cat"), `{"url":"http://x"}`, `{"cmd":"scroll","id":"a","dy":1}`)
	if st.Status != "ok" || st.Commands != 0 || len(lines) != 2 || lines[0] != `{"url":"http://x"}` {
		t.Fatalf("status = %+v, lines = %q", st, lines)
	}
}

func TestSessionOfTheWrongTypeIsABadJob(t *testing.T) {
	for _, job := range []string{`{"session":true}`, `{"session":"yes"}`, `{"session":{"max_s":"long"}}`, `{"session":[1]}`} {
		_, st := runJob(t, sessionConfig("cat"), job)
		if st.Status != "bad_job" {
			t.Fatalf("job %s: status = %+v", job, st)
		}
	}
}

func TestBadCommandEndsTheJobAndKillsTheCollector(t *testing.T) {
	long4097 := `{"a":"` + strings.Repeat("x", 4097-8) + `"}`
	if len(long4097) != 4097 {
		t.Fatalf("test data has %d bytes", len(long4097))
	}
	cases := map[string]string{
		"not json":             `hello`,
		"json array":           `[1,2]`,
		"truncated json":       `{"cmd":`,
		"over the limit":       long4097,
		"longer than a buffer": `{"a":"` + strings.Repeat("x", 6000) + `"}`,
	}
	for name, cmd := range cases {
		t.Run(name, func(t *testing.T) {
			pidfile := filepath.Join(t.TempDir(), "pid")
			cfg := sessionConfig(`read job; echo $$ > ` + pidfile + `; sleep 60`)
			begin := time.Now()
			_, st := sendSession(t, cfg, sessionJob, cmd)
			if st.Status != "bad_command" {
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
		})
	}
}

func TestTooManyCommands(t *testing.T) {
	cfg := sessionConfig(`read job; sleep 60`)
	cfg.MaxCmds = 3
	cmds := make([]string, 4)
	for i := range cmds {
		cmds[i] = `{"cmd":"wait","id":"` + strconv.Itoa(i) + `","ms":1}`
	}
	_, st := sendSession(t, cfg, sessionJob, cmds...)
	if st.Status != "bad_command" || st.Commands != 3 {
		t.Fatalf("status = %+v", st)
	}
}

func TestSessionTimeoutComesFromMaxS(t *testing.T) {
	cfg := sessionConfig(`read job; sleep 60`)
	begin := time.Now()
	_, st := sendSession(t, cfg, `{"session":{"max_s":1}}`)
	if st.Status != "timeout" {
		t.Fatalf("status = %+v", st)
	}
	if d := time.Since(begin); d < 1200*time.Millisecond || d > 4*time.Second {
		t.Fatalf("took %v, want about max_s + grace = 1.3 s", d)
	}
}

func TestSessionMaxIsCappedByTheAgent(t *testing.T) {
	cfg := sessionConfig(`read job; sleep 60`)
	cfg.SessionMax = time.Second
	begin := time.Now()
	_, st := sendSession(t, cfg, `{"session":{"max_s":99999}}`)
	if st.Status != "timeout" || time.Since(begin) > 4*time.Second {
		t.Fatalf("status = %+v after %v", st, time.Since(begin))
	}
}

func TestClientLeavingKillsASessionCollector(t *testing.T) {
	pidfile := filepath.Join(t.TempDir(), "pid")
	ag, dial := serve(t, sessionConfig(`read job; echo $$ > `+pidfile+`; sleep 60`))
	c := dial()
	if _, err := c.Write([]byte(sessionJob + "\n")); err != nil {
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
		t.Fatal("collector did not start")
	}
	c.Close()
	waitDead(t, pid)
	for i := 0; i < 40 && ag.busy.Load(); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if ag.busy.Load() {
		t.Fatal("agent still busy after the client left")
	}
}

func TestCollectorExitingBeforeCommandsIsNotAnError(t *testing.T) {
	cfg := sessionConfig(`read job; echo finished`)
	lines, st := sendSession(t, cfg, sessionJob, `{"cmd":"wait","id":"late","ms":1}`)
	if st.Status != "ok" || len(lines) < 2 || lines[0] != "finished" {
		t.Fatalf("status = %+v, lines = %q", st, lines)
	}
}

func TestSessionSlotIsBusyWhileTheSessionRuns(t *testing.T) {
	_, dial := serve(t, sessionConfig(`read job; sleep 2`))
	c1 := dial()
	defer c1.Close()
	if _, err := c1.Write([]byte(sessionJob + "\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	c2 := dial()
	defer c2.Close()
	_, _ = c2.Write([]byte(`{"kind":"url"}` + "\n"))
	if st := lastStatus(t, readLines(t, c2)); st.Status != "busy" {
		t.Fatalf("status = %+v", st)
	}
}
