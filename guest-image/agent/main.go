package main

import (
	"flag"
	"log"
	"time"
)

func main() {
	port := flag.Uint("port", 5000, "vsock port")
	user := flag.String("user", "pw", "run the collector as this user")
	timeout := flag.Duration("timeout", 60*time.Second, "collector wall-clock limit")
	maxOut := flag.Int64("max-out", 1<<20, "max collector output bytes forwarded")
	maxJob := flag.Int("max-job", 64<<10, "max job line bytes")
	sessionMax := flag.Duration("session-max", 600*time.Second, "upper bound for session.max_s in a job")
	sessionGrace := flag.Duration("session-grace", 30*time.Second, "added to session.max_s before the collector is killed")
	maxCmd := flag.Int("max-cmd", 4096, "max bytes of one command line (session jobs)")
	maxCmds := flag.Int("max-cmds", 200, "max commands per job (session jobs)")
	flag.Parse()

	cmd := flag.Args()
	if len(cmd) == 0 {
		cmd = []string{"/opt/node/bin/node", "/opt/collector/collect.mjs"}
	}
	ag, err := NewAgent(Config{
		Cmd:            cmd,
		User:           *user,
		Timeout:        *timeout,
		MaxOut:         *maxOut,
		MaxJob:         *maxJob,
		ReadJobTimeout: 5 * time.Second,
		SessionMax:     *sessionMax,
		SessionGrace:   *sessionGrace,
		MaxCmd:         *maxCmd,
		MaxCmds:        *maxCmds,
		Env: []string{
			"PATH=/opt/node/bin:/usr/bin:/bin",
			"HOME=/home/pw",
			"LANG=C.UTF-8",
			"PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers",
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	ln, err := listenVsock(uint32(*port))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("listening on vsock port %d", *port)
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go ag.Handle(c)
	}
}
