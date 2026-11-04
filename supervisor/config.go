package main

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

// Config holds every setting. The environment variables and their ranges are those of spec 006, section 4.
type Config struct {
	Concurrency      int
	QueueMax         int
	QueueWait        time.Duration
	BootTimeout      time.Duration
	HardTimeout      time.Duration
	VCPU             int
	MemMiB           int
	MinFreeGB        int
	ResultTTL        time.Duration
	MaxEvidenceBytes int
	SessionSlots     int
	SessionIdle      time.Duration
	SessionMax       time.Duration
	SessionGrace     time.Duration
	ApprovalTTL      time.Duration
	CommandMax       int
	CommandTimeout   time.Duration
	ShutdownGrace    time.Duration
	Keepalive        time.Duration
	VsockPort        int
	SocketPath       string
	StateDir         string
	RunsDir          string
	ResultsDir       string
	ArtifactsDir     string
	// MaxArtifactBytes is the total of one run, MaxArtifacts the number of files, ArtifactFetchTimeout the time for one.
	MaxArtifactBytes     int64
	MaxArtifacts         int
	ArtifactFetchTimeout time.Duration
	RecordsDir           string
	ImageDir             string
	ImagePath            string
	KernelPath           string
	FirecrackerPath      string
	ZsnetPath            string
	ZsvmPath             string
}

var digitsRe = regexp.MustCompile(`^\d+$`)

func envInt(env map[string]string, name string, def, min, max int) (int, error) {
	raw, ok := env[name]
	if !ok || raw == "" {
		return def, nil
	}
	if !digitsRe.MatchString(raw) {
		return 0, fmt.Errorf("%s must be a non-negative integer", name)
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < min || v > max {
		return 0, fmt.Errorf("%s must be between %d and %d", name, min, max)
	}
	return v, nil
}

func envStr(env map[string]string, name, def string) string {
	if v := env[name]; v != "" {
		return v
	}
	return def
}

// LoadConfig reads the settings from env (usually the process environment as a map).
func LoadConfig(env map[string]string) (Config, error) {
	stateDir := envStr(env, "SUP_STATE_DIR", "/var/lib/zerostress")
	imageDir := envStr(env, "SUP_IMAGE_DIR", "/opt/zerostress/images")
	var firstErr error
	get := func(name string, def, min, max int) int {
		v, err := envInt(env, name, def, min, max)
		if err != nil && firstErr == nil {
			firstErr = err
		}
		return v
	}
	sec := func(n int) time.Duration { return time.Duration(n) * time.Second }
	c := Config{
		// slots 0..3 exist in zsnet, so at most four microVMs at a time
		Concurrency:      get("SUP_CONCURRENCY", 2, 1, 4),
		QueueMax:         get("SUP_QUEUE_MAX", 20, 1, 1000),
		QueueWait:        sec(get("SUP_QUEUE_WAIT_S", 120, 1, 3600)),
		BootTimeout:      sec(get("SUP_BOOT_TIMEOUT_S", 15, 1, 120)),
		HardTimeout:      sec(get("SUP_HARD_TIMEOUT_S", 90, 5, 600)),
		VCPU:             get("SUP_VCPU", 2, 1, 4),
		MemMiB:           get("SUP_MEM_MIB", 1024, 256, 4096),
		MinFreeGB:        get("SUP_MIN_FREE_GB", 20, 0, 1000),
		ResultTTL:        time.Duration(get("SUP_RESULT_TTL_H", 24, 1, 24*30)) * time.Hour,
		MaxEvidenceBytes: 2 * 1024 * 1024,
		SessionSlots:     get("SUP_SESSION_SLOTS", 1, 0, 4),
		SessionIdle:      sec(get("SUP_SESSION_IDLE_S", 60, 5, 120)),
		SessionMax:       sec(get("SUP_SESSION_MAX_S", 300, 30, 600)),
		SessionGrace:     sec(get("SUP_SESSION_GRACE_S", 30, 1, 120)),
		ApprovalTTL:      sec(get("SUP_APPROVAL_TTL_S", 300, 10, 3600)),
		// the agent forwards at most 200 lines per job (004, 8e): keep room for the supervisor's own close
		CommandMax:     get("SUP_COMMAND_MAX", 190, 1, 199),
		CommandTimeout: sec(get("SUP_COMMAND_TIMEOUT_S", 30, 1, 120)),
		ShutdownGrace:  10 * time.Second,
		Keepalive:      15 * time.Second,
		VsockPort:      5000,
		SocketPath:     envStr(env, "SUP_SOCKET", "/run/zerostress/supervisor.sock"),
		StateDir:       stateDir,
		RunsDir:        filepath.Join(stateDir, "runs"),
		ResultsDir:     filepath.Join(stateDir, "results"),
		ArtifactsDir:   filepath.Join(stateDir, "artifacts"),
		RecordsDir:     filepath.Join(stateDir, "records"),
		// the guest holds at most this much (the collector's own limit) and hands over at most this many files
		MaxArtifactBytes:     32 << 20,
		MaxArtifacts:         16,
		ArtifactFetchTimeout: 20 * time.Second,
		ImageDir:             imageDir,
		ImagePath:            filepath.Join(imageDir, "guest-rootfs.ext4"),
		KernelPath:           envStr(env, "SUP_KERNEL", filepath.Join(imageDir, "vmlinux-6.18.56")),
		FirecrackerPath:      envStr(env, "SUP_FIRECRACKER", "/opt/zerostress/bin/firecracker"),
		ZsnetPath:            envStr(env, "SUP_ZSNET", "/opt/zerostress/bin/zsnet"),
		ZsvmPath:             envStr(env, "SUP_ZSVM", "/opt/zerostress/bin/zsvm"),
	}
	return c, firstErr
}
