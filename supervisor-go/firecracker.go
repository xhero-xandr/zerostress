package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const consoleKeep = 64 * 1024

// This file is the whole Firecracker client: six REST calls over a Unix socket and the process around them. It is the
// one piece a library (firecracker-go-sdk) could replace; see docs/TOOLS.md for why it does not.

var cleanEnv = []string{"PATH=/usr/bin:/bin"}

// fcPut is one Firecracker API call. Every configuration step must answer 204.
func fcPut(ctx context.Context, apiSock, path string, body string) error {
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", apiSock)
			},
			DisableKeepAlives: true,
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://firecracker"+path, bytes.NewBufferString(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return newRunError(ReasonFcAPI, fmt.Sprintf("PUT %s: %v", path, err))
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	return newRunError(ReasonFcAPI, fmt.Sprintf("PUT %s -> %d %s", path, resp.StatusCode, b))
}

func bootArgs(slot int) string {
	return fmt.Sprintf("console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.%d.2::172.16.%d.1:255.255.255.252::eth0:off:1.1.1.1", slot, slot)
}

func guestMAC(slot int) string { return fmt.Sprintf("06:00:AC:10:0%d:02", slot) }

// ringBuffer keeps the last consoleKeep bytes written to it.
type ringBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, p...)
	if len(r.buf) > consoleKeep {
		r.buf = r.buf[len(r.buf)-consoleKeep:]
	}
	return len(p), nil
}

func (r *ringBuffer) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.buf)
}

// stdioSocket makes a connected Unix socket pair for one output stream of a child process: the parent end is read
// here, the child end becomes the child's stdout or stderr. Node gives its children socket pairs (libuv); os/exec
// would give pipes.
func stdioSocket() (parent, child *os.File, err error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	return os.NewFile(uintptr(fds[0]), "console"), os.NewFile(uintptr(fds[1]), "console-child"), nil
}

// firecrackerVM is a microVM run as a systemd unit by the root helper zsvm (cgroup limits, guaranteed network
// teardown). The helper blocks until the unit has ended, so the exit of this child means "the VM is gone", and the
// guest serial console arrives on its stdout. It is read into a small ring buffer, never to a file: a guest could
// flood it.
type firecrackerVM struct {
	cfg      Config
	runID    string
	apiSock  string
	vsockUDS string
	cmd      *exec.Cmd
	console  *ringBuffer
	exited   chan struct{}

	mu      sync.Mutex
	writer  func(string) error
	stopped bool
}

func launchFirecracker(ctx context.Context, cfg Config, o StartOptions) (*firecrackerVM, error) {
	vm := &firecrackerVM{
		cfg: cfg, runID: o.RunID, console: &ringBuffer{}, exited: make(chan struct{}),
		apiSock: filepath.Join(o.RunDir, "fc.sock"), vsockUDS: filepath.Join(o.RunDir, "v.sock"),
	}
	// no CommandContext: the VM must be stopped through zsvm (which tears the network down), not killed from here
	vm.cmd = exec.Command("/usr/bin/sudo", "-n", cfg.ZsvmPath, "run", fmt.Sprint(o.Slot), o.RunID, fmt.Sprint(o.MemMiB), fmt.Sprint(o.VCPU))
	vm.cmd.Env = cleanEnv
	vm.cmd.Dir = o.RunDir
	// systemd-run --pipe hands the child's descriptors on to the unit through the system bus.
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return nil, newRunError(ReasonFcAPI, "could not open "+os.DevNull+": "+err.Error())
	}
	defer devNull.Close()
	outP, outC, err := stdioSocket()
	if err != nil {
		return nil, newRunError(ReasonFcAPI, "could not create the console socket: "+err.Error())
	}
	errP, errC, err := stdioSocket()
	if err != nil {
		outP.Close()
		outC.Close()
		return nil, newRunError(ReasonFcAPI, "could not create the console socket: "+err.Error())
	}
	vm.cmd.Stdin = devNull
	vm.cmd.Stdout = outC
	vm.cmd.Stderr = errC
	startErr := vm.cmd.Start()
	outC.Close() // the child has its own copies now
	errC.Close()
	if startErr != nil {
		outP.Close()
		errP.Close()
		fmt.Fprintf(vm.console, "spawn error: %v\n", startErr)
		close(vm.exited)
		return nil, newRunError(ReasonFcAPI, "could not start the VM helper: "+startErr.Error())
	}
	for _, p := range []*os.File{outP, errP} {
		go func(p *os.File) {
			defer p.Close()
			_, _ = io.Copy(vm.console, p)
		}(p)
	}
	go func() {
		_ = vm.cmd.Wait()
		close(vm.exited)
	}()

	fail := func(err error) (*firecrackerVM, error) {
		vm.Stop()
		if ctx.Err() != nil {
			return nil, context.Cause(ctx)
		}
		return nil, err
	}
	for i := 0; i < 50; i++ {
		if _, err := os.Stat(vm.apiSock); err == nil {
			break
		}
		select {
		case <-vm.exited:
		case <-ctx.Done():
		case <-time.After(60 * time.Millisecond):
		}
		if ctx.Err() != nil || vm.isDead() {
			break
		}
	}
	if _, err := os.Stat(vm.apiSock); err != nil || vm.isDead() {
		return fail(newRunError(ReasonFcAPI, "firecracker did not start: "+clip(tail(vm.Console(), 200), 200)))
	}
	steps := []struct{ path, body string }{
		{"/machine-config", fmt.Sprintf(`{"vcpu_count":%d,"mem_size_mib":%d}`, o.VCPU, o.MemMiB)},
		{"/boot-source", fmt.Sprintf(`{"kernel_image_path":%q,"boot_args":%q}`, cfg.KernelPath, bootArgs(o.Slot))},
		{"/drives/rootfs", fmt.Sprintf(`{"drive_id":"rootfs","path_on_host":%q,"is_root_device":true,"is_read_only":false}`, filepath.Join(o.RunDir, "rootfs.ext4"))},
		{"/network-interfaces/net1", fmt.Sprintf(`{"iface_id":"net1","guest_mac":%q,"host_dev_name":"zstap%d"}`, guestMAC(o.Slot), o.Slot)},
		{"/vsock", fmt.Sprintf(`{"guest_cid":3,"uds_path":%q}`, vm.vsockUDS)},
		{"/actions", `{"action_type":"InstanceStart"}`},
	}
	for _, st := range steps {
		if err := fcPut(ctx, vm.apiSock, st.path, st.body); err != nil {
			return fail(err)
		}
	}
	return vm, nil
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func (v *firecrackerVM) isDead() bool {
	select {
	case <-v.exited:
		return true
	default:
		return false
	}
}

func (v *firecrackerVM) WaitReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		if v.isDead() {
			return newRunError(ReasonFcCrashed, "firecracker exited during boot: "+clip(tail(v.Console(), 200), 200))
		}
		if probeAgent(ctx, v.vsockUDS, v.cfg.VsockPort) {
			return nil
		}
		if time.Now().After(deadline) {
			return newRunError(ReasonBootTimeout, "the guest agent did not come up in time")
		}
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (v *firecrackerVM) RunJob(ctx context.Context, job string, onLine func(string)) error {
	defer func() {
		v.mu.Lock()
		v.writer = nil
		v.mu.Unlock()
	}()
	err := runAgentJob(ctx, v.vsockUDS, v.cfg.VsockPort, job, onLine, v.cfg.MaxEvidenceBytes, func(w func(string) error) {
		v.mu.Lock()
		v.writer = w
		v.mu.Unlock()
	})
	if err != nil {
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		return newRunError(ReasonAgentError, err.Error())
	}
	return nil
}

func (v *firecrackerVM) Send(line string) error {
	v.mu.Lock()
	w := v.writer
	v.mu.Unlock()
	if w == nil {
		return errors.New("no open agent connection")
	}
	return w(line)
}

func (v *firecrackerVM) Exited() <-chan struct{} { return v.exited }

func (v *firecrackerVM) Console() string { return v.console.String() }

// Stop stops the unit (SIGTERM; verified to end Firecracker in well under a second) and waits until the helper has
// returned, which happens only after ExecStopPost has torn the slot's network down. The slot must not be reused
// before that, or a late "zsnet down" could remove the network of the next VM on the same slot.
func (v *firecrackerVM) Stop() {
	v.mu.Lock()
	if v.stopped {
		v.mu.Unlock()
		<-v.exited
		return
	}
	v.stopped = true
	v.mu.Unlock()
	if v.isDead() {
		return
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c := exec.CommandContext(stopCtx, "/usr/bin/sudo", "-n", v.cfg.ZsvmPath, "stop", v.runID)
	c.Env = cleanEnv
	_ = c.Run()
	select {
	case <-v.exited:
		return
	case <-time.After(8 * time.Second):
	}
	if !v.isDead() {
		_ = v.cmd.Process.Kill() // the sudo child only; the unit is already stopped or stuck for systemd to handle
	}
	select {
	case <-v.exited:
	case <-time.After(2 * time.Second):
	}
}
