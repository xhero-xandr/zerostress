// Command zerostress-supervisor is the privileged supervisor: one disposable Firecracker microVM per job.
// Standard library only (docs/containment.md, rule 6). Spec 006.
package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func environ() map[string]string {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	return env
}

func main() {
	log := stdoutLogger()
	cfg, err := LoadConfig(environ())
	if err != nil {
		log("error", "bad configuration", map[string]any{"detail": err.Error()})
		os.Exit(2)
	}
	for _, d := range []string{cfg.StateDir, cfg.RunsDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			log("error", "cannot create state directory", map[string]any{"dir": d, "detail": err.Error()})
			os.Exit(1)
		}
	}
	store, problems := NewStore(cfg.RecordsDir)
	for _, p := range problems {
		log("warn", "record skipped", map[string]any{"detail": clip(p.Error(), 200)})
	}
	results, err := NewResultFiles(cfg.ResultsDir)
	if err != nil {
		log("error", "cannot create results directory", map[string]any{"detail": err.Error()})
		os.Exit(1)
	}
	artifacts, err := NewArtifactFiles(cfg.ArtifactsDir)
	if err != nil {
		log("error", "cannot create artifacts directory", map[string]any{"detail": err.Error()})
		os.Exit(1)
	}
	sup := NewSupervisor(Deps{
		Config: cfg, Store: store, Results: results, Artifacts: artifacts, Backend: NewLinuxBackend(cfg, log), Log: log,
		FreeGB: freeGBOf(cfg.StateDir), ImageSHA256: imageSHAFrom(cfg.ImageDir),
	})
	if err := sup.Start(context.Background()); err != nil {
		log("error", "start failed", map[string]any{"detail": err.Error()})
		os.Exit(1)
	}

	_ = os.Remove(cfg.SocketPath) // stale socket of a previous process
	ln, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		log("error", "cannot listen", map[string]any{"socket": cfg.SocketPath, "detail": err.Error()})
		os.Exit(1)
	}
	// access is granted by file permissions: owner and group (zerostress-ipc, the web layer), nobody else
	if err := os.Chmod(cfg.SocketPath, 0o660); err != nil {
		log("error", "cannot set socket permissions", map[string]any{"detail": err.Error()})
		os.Exit(1)
	}
	srv := &http.Server{Handler: NewAPI(sup, cfg, log), ReadHeaderTimeout: 10 * time.Second}
	log("info", "supervisor listening", map[string]any{"socket": cfg.SocketPath, "concurrency": cfg.Concurrency, "queue_max": cfg.QueueMax, "impl": "go"})

	served := make(chan struct{})
	go func() {
		_ = srv.Serve(ln)
		close(served)
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	s := <-sig
	log("info", "shutting down", map[string]any{"signal": s.String()})
	_ = ln.Close()
	sup.Shutdown()
	_ = srv.Close()
	<-served
	os.Exit(0)
}
