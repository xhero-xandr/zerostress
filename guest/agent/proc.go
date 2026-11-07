package main

import (
	"bufio"
	"log"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// processesOf lists the processes whose real or effective uid is uid, read from /proc. The agent itself is never in
// the list.
func processesOf(uid uint32) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	self := os.Getpid()
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		if real, eff, ok := uidsOf(pid); ok && (real == uid || eff == uid) {
			pids = append(pids, pid)
		}
	}
	return pids
}

func uidsOf(pid int) (real, eff uint32, ok bool) {
	f, err := os.Open("/proc/" + strconv.Itoa(pid) + "/status")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		rest, found := strings.CutPrefix(sc.Text(), "Uid:")
		if !found {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 2 {
			return 0, 0, false
		}
		r, err1 := strconv.ParseUint(f[0], 10, 32)
		e, err2 := strconv.ParseUint(f[1], 10, 32)
		return uint32(r), uint32(e), err1 == nil && err2 == nil
	}
	return 0, 0, false
}

// killUser kills every process of the job user: one that left the job's process group (setsid) is still that user's.
// It sweeps /proc again until a pass finds nothing, since a process may fork while the previous pass runs; a dead
// process cannot fork, so each pass can only find the children of the last one. Returns what the last pass still saw.
func killUser(uid uint32) int {
	for pass := 0; pass < 50; pass++ {
		pids := processesOf(uid)
		if len(pids) == 0 {
			return 0
		}
		for _, pid := range pids {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return len(processesOf(uid))
}

// outputGrace is how long the job's output stays open after the job was stopped, for what is already in the pipe.
const outputGrace = 500 * time.Millisecond

// killJobUser ends every process of the user the job runs as. Only when the job has a user of its own: without one
// (tests, a local run) that user is the agent's, and killing it would kill the agent's neighbours.
func (a *Agent) killJobUser() {
	if a.cred == nil || a.cred.Uid == 0 {
		return
	}
	if left := killUser(a.cred.Uid); left > 0 {
		log.Printf("%d processes of the job user survived the sweep", left)
	}
}
