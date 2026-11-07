package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A process of the job may leave its process group (setsid) and keep the output open. The timeout must still hold, and
// the process must not outlive the job.

func TestTimeoutHoldsWhenAProcessLeavesTheGroupAndKeepsTheOutput(t *testing.T) {
	cfg := testConfig(`exec 2>/dev/null; setsid sleep 8 & sleep 60`)
	cfg.Timeout = 400 * time.Millisecond
	begin := time.Now()
	_, st := runJob(t, cfg, `{}`)
	if st.Status != "timeout" {
		t.Fatalf("status = %+v", st)
	}
	if took := time.Since(begin); took > 4*time.Second {
		t.Fatalf("the timeout did not hold: took %v", took)
	}
}

// Needs root: the job runs as a uid of its own, as in the guest, and afterwards no process of that uid may be left.
func TestEveryProcessOfTheJobUserIsKilled(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to run the job as another user")
	}
	const uid = 64999 // no such user on a normal host: nothing else of it can be running
	if n := len(processesOf(uid)); n != 0 {
		t.Skipf("uid %d already has %d processes on this machine", uid, n)
	}
	dir := t.TempDir()
	for d := dir; d != "/" && d != os.TempDir(); d = filepath.Dir(d) {
		_ = os.Chmod(d, 0o755)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	pidfile := filepath.Join(dir, "pid")
	for _, tc := range []struct {
		name, script string
		timeout      time.Duration
	}{
		{"on timeout", `exec 2>/dev/null; setsid sleep 30 & echo $! > ` + pidfile + `; sleep 60`, 400 * time.Millisecond},
		{"after a normal end", `setsid sleep 30 </dev/null >/dev/null 2>&1 & echo $! > ` + pidfile + `; echo '{"type":"status","status":"ok"}'`, 5 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_ = os.Remove(pidfile)
			cfg := testConfig(tc.script)
			cfg.Timeout = tc.timeout
			ag, err := NewAgent(cfg)
			if err != nil {
				t.Fatal(err)
			}
			ag.cred = &syscall.Credential{Uid: uid, Gid: uid, Groups: []uint32{}}
			_, st := runJobOn(t, ag, `{}`)
			b, err := os.ReadFile(pidfile)
			if err != nil {
				t.Fatalf("the job did not start its process (status %+v): %v", st, err)
			}
			pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
			waitDead(t, pid)
			if left := processesOf(uid); len(left) != 0 {
				t.Fatalf("processes of the job user left: %v", left)
			}
		})
	}
}
