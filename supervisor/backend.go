package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const maxSlot = 3

var allDigits = regexp.MustCompile(`^\d+$`)

// run executes a command without a shell and with a clean environment.
func run(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c := exec.CommandContext(ctx, name, args...)
	c.Env = cleanEnv
	var out, errb bytes.Buffer
	c.Stdout = &out
	c.Stderr = &errb
	if err := c.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(clip(msg, 300))
	}
	return out.String(), nil
}

func slotArg(slot int) (string, error) {
	if slot < 0 || slot > maxSlot {
		return "", fmt.Errorf("invalid slot %d", slot)
	}
	return strconv.Itoa(slot), nil
}

// LinuxBackend is the real host: cp for disks, sudo zsnet for the network, Firecracker for the VM.
type LinuxBackend struct {
	cfg Config
	log Logger
}

func NewLinuxBackend(cfg Config, log Logger) *LinuxBackend {
	if log == nil {
		log = nullLogger
	}
	return &LinuxBackend{cfg: cfg, log: log}
}

func (b *LinuxBackend) PrepareDisk(ctx context.Context, runDir string) error {
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return newRunError(ReasonDiskCopy, err.Error())
	}
	disk := filepath.Join(runDir, "rootfs.ext4")
	if _, err := run(ctx, 60*time.Second, "/usr/bin/cp", "--sparse=always", b.cfg.ImagePath, disk); err != nil {
		return newRunError(ReasonDiskCopy, err.Error())
	}
	if err := os.Chmod(disk, 0o600); err != nil {
		return newRunError(ReasonDiskCopy, err.Error())
	}
	return nil
}

func (b *LinuxBackend) NetUp(ctx context.Context, slot int, _ string) error {
	s, err := slotArg(slot)
	if err == nil {
		_, err = run(ctx, 15*time.Second, "/usr/bin/sudo", "-n", b.cfg.ZsnetPath, "up", s)
	}
	if err != nil {
		return newRunError(ReasonNetSetup, err.Error())
	}
	return nil
}

func (b *LinuxBackend) NetDown(ctx context.Context, slot int, _ string) error {
	s, err := slotArg(slot)
	if err != nil {
		return err
	}
	_, err = run(ctx, 15*time.Second, "/usr/bin/sudo", "-n", b.cfg.ZsnetPath, "down", s)
	return err
}

func (b *LinuxBackend) Start(ctx context.Context, o StartOptions) (VM, error) {
	vm, err := launchFirecracker(ctx, b.cfg, o)
	if err != nil {
		return nil, err
	}
	return vm, nil
}

func (b *LinuxBackend) RemoveRunDir(runDir string) error { return os.RemoveAll(runDir) }

// RecoverHost is the startup recovery of spec 006, 3.5: nothing from a previous process may survive.
func (b *LinuxBackend) RecoverHost(ctx context.Context) error {
	if err := os.MkdirAll(b.cfg.RunsDir, 0o700); err != nil {
		return err
	}
	if out, err := run(ctx, 60*time.Second, "/usr/bin/sudo", "-n", b.cfg.ZsvmPath, "recover"); err != nil {
		b.log("warn", "recovery: zsvm recover failed", map[string]any{"detail": clip(err.Error(), 200)})
	} else {
		b.log("info", "recovery: VM units", map[string]any{"detail": clip(strings.TrimSpace(out), 100)})
	}
	killed := 0
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		if !allDigits.MatchString(e.Name()) {
			continue
		}
		pid, _ := strconv.Atoi(e.Name())
		if pid == os.Getpid() {
			continue
		}
		cmdline, err := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if err != nil {
			continue
		}
		if strings.Contains(string(cmdline), b.cfg.RunsDir) {
			if syscall.Kill(pid, syscall.SIGKILL) == nil {
				killed++
			}
		}
	}
	if killed > 0 {
		time.Sleep(300 * time.Millisecond)
	}
	for slot := 0; slot <= maxSlot; slot++ {
		if err := b.NetDown(ctx, slot, ""); err != nil {
			b.log("warn", "recovery: zsnet down failed", map[string]any{"slot": slot, "detail": clip(err.Error(), 200)})
		}
	}
	removed := 0
	dirs, _ := os.ReadDir(b.cfg.RunsDir)
	for _, d := range dirs {
		_ = os.RemoveAll(filepath.Join(b.cfg.RunsDir, d.Name()))
		removed++
	}
	b.log("info", "recovery done", map[string]any{"killed": killed, "removed_dirs": removed})
	return nil
}

// freeGBOf reports the free space of the filesystem holding path.
func freeGBOf(path string) func() float64 {
	return func() float64 {
		var st syscall.Statfs_t
		if err := syscall.Statfs(path, &st); err != nil {
			return 0
		}
		return float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
	}
}

// imageSHAFrom reads the SHA-256 of the installed guest image as recorded by guest/image/build.sh, for /v1/health.
func imageSHAFrom(imageDir string) func() string {
	var cached *string
	return func() string {
		if cached != nil {
			return *cached
		}
		sha := ""
		if b, err := os.ReadFile(filepath.Join(imageDir, "manifest.json")); err == nil {
			var m struct {
				Image struct {
					SHA256 string `json:"sha256"`
				} `json:"image"`
			}
			if json.Unmarshal(b, &m) == nil {
				sha = m.Image.SHA256
			}
		}
		cached = &sha
		return sha
	}
}
