package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---- waiting -------------------------------------------------------------------------------------------------

func sleep(d time.Duration) { time.Sleep(d) }

// waitFor polls fn until it is true or the time is up.
func waitFor(t testing.TB, what string, fn func() bool, limit ...time.Duration) {
	t.Helper()
	d := 3 * time.Second
	if len(limit) > 0 {
		d = limit[0]
	}
	end := time.Now().Add(d)
	for !fn() {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ---- fake host -----------------------------------------------------------------------------------------------

const (
	okStatus     = `{"type":"status","status":"ok","exit_code":0,"duration_ms":5}`
	sessionReady = `{"type":"evidence","v":1,"kind":"session_ready"}`
)

func statusLine(s string) string {
	return fmt.Sprintf(`{"type":"status","status":%q,"duration_ms":5}`, s)
}

func cmdResultLine(id string, ok bool, errCode string) string {
	m := map[string]any{"type": "evidence", "v": 1, "kind": "cmd_result", "id": id, "ok": ok}
	if errCode != "" {
		m["error"] = errCode
	}
	b, _ := json.Marshal(m)
	return string(b)
}

// Script says what the fake host does for a run. The zero value is a run that succeeds with no output.
type Script struct {
	PrepareDiskFail bool
	NetUpFail       bool
	StartFail       bool
	Ready           string // "", "timeout" or "crash"
	Lines           []string
	LineDelay       time.Duration
	Hang            bool // keep the stream open after the lines until the run is aborted
	CrashAtLine     *int // the VM dies right before this line (index) is delivered
	// Session scripts: called for every command line the supervisor sends. Default: answer with cmd_result and end
	// the stream on close.
	OnCommand func(cmd map[string]any, vm *FakeVM)
	Silent    bool // never answer commands (the supervisor's command timeout must fire)
	SendFails bool // writing a command to the guest fails
	ReplyWait time.Duration
}

type pushItem struct {
	line string
	end  bool
}

type FakeVM struct {
	b       *FakeBackend
	script  Script
	exited  chan struct{}
	dead    atomic.Bool
	killing sync.Once
	pushes  chan pushItem
	open    atomic.Bool

	mu   sync.Mutex
	job  string
	sent []string
}

func (v *FakeVM) kill() {
	v.killing.Do(func() {
		v.dead.Store(true)
		close(v.exited)
	})
}

func (v *FakeVM) WaitReady(ctx context.Context, timeout time.Duration) error {
	switch v.script.Ready {
	case "crash":
		v.kill()
		return newRunError(ReasonFcCrashed, "died during boot")
	case "timeout":
		select {
		case <-time.After(timeout):
		case <-ctx.Done():
			return context.Cause(ctx)
		}
		return newRunError(ReasonBootTimeout, "agent not ready")
	}
	time.Sleep(time.Millisecond)
	return nil
}

func (v *FakeVM) RunJob(ctx context.Context, job string, onLine func(string)) error {
	v.mu.Lock()
	v.job = job
	v.mu.Unlock()
	v.b.mu.Lock()
	v.b.lastJob = job
	v.b.mu.Unlock()
	v.open.Store(true)
	defer v.open.Store(false)
	for i, line := range v.script.Lines {
		if ctx.Err() != nil || v.dead.Load() {
			return ctxErr(ctx)
		}
		if v.script.LineDelay > 0 {
			time.Sleep(v.script.LineDelay)
		}
		if v.script.CrashAtLine != nil && *v.script.CrashAtLine == i {
			v.kill()
			return nil
		}
		onLine(line)
	}
	if !v.script.Hang {
		return nil
	}
	for {
		select {
		case it := <-v.pushes:
			onLine(it.line)
			if it.end {
				return nil
			}
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-v.exited:
			return nil
		}
	}
}

func ctxErr(ctx context.Context) error {
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	return nil
}

// Push is a line from the guest, as if the collector had printed it. It is delivered from the goroutine that runs RunJob.
func (v *FakeVM) Push(line string) { v.pushes <- pushItem{line: line} }

// Finish makes the collector exit: a last line (default: the ok status), then the connection closes.
func (v *FakeVM) Finish(lastLine ...string) {
	l := okStatus
	if len(lastLine) > 0 {
		l = lastLine[0]
	}
	v.pushes <- pushItem{line: l, end: true}
}

// Sent returns the lines the supervisor wrote after the job (session commands).
func (v *FakeVM) Sent() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return append([]string(nil), v.sent...)
}

// Job is the job line the supervisor sent.
func (v *FakeVM) Job() string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.job
}

func (v *FakeVM) Send(line string) error {
	if v.script.SendFails {
		return fmt.Errorf("socket closed")
	}
	if !v.open.Load() || v.dead.Load() {
		return fmt.Errorf("no open agent connection")
	}
	v.mu.Lock()
	v.sent = append(v.sent, line)
	v.mu.Unlock()
	var cmd map[string]any
	_ = json.Unmarshal([]byte(line), &cmd)
	if v.script.OnCommand != nil {
		v.script.OnCommand(cmd, v)
		return nil
	}
	if v.script.Silent {
		return nil
	}
	wait := v.script.ReplyWait
	if wait == 0 {
		wait = 2 * time.Millisecond
	}
	time.AfterFunc(wait, func() {
		if v.dead.Load() {
			return
		}
		id, _ := cmd["id"].(string)
		v.Push(cmdResultLine(id, true, ""))
		if cmd["cmd"] == "close" {
			v.Finish()
		}
	})
	return nil
}

func (v *FakeVM) Exited() <-chan struct{} { return v.exited }

func (v *FakeVM) Stop() {
	v.kill()
	v.b.mu.Lock()
	delete(v.b.vms, v)
	v.b.mu.Unlock()
}

func (v *FakeVM) Console() string { return "" }

type FakeBackend struct {
	scriptFor func(runID string) Script

	mu        sync.Mutex
	calls     []string
	slotsUp   map[int]bool
	dirs      map[string]bool
	vms       map[*FakeVM]bool
	vmByRun   map[string]*FakeVM
	maxVMs    int
	started   []string
	lastJob   string
	recovered int
}

func newFakeBackend(scriptFor func(string) Script) *FakeBackend {
	return &FakeBackend{scriptFor: scriptFor, slotsUp: map[int]bool{}, dirs: map[string]bool{}, vms: map[*FakeVM]bool{}, vmByRun: map[string]*FakeVM{}}
}

func (b *FakeBackend) record(c string) {
	b.mu.Lock()
	b.calls = append(b.calls, c)
	b.mu.Unlock()
}

func (b *FakeBackend) Calls() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.calls...)
}

func (b *FakeBackend) PrepareDisk(_ context.Context, runDir string) error {
	b.record("prepareDisk")
	if b.scriptFor(filepath.Base(runDir)).PrepareDiskFail {
		return fmt.Errorf("copy failed")
	}
	b.mu.Lock()
	b.dirs[runDir] = true
	b.mu.Unlock()
	return nil
}

func (b *FakeBackend) NetUp(_ context.Context, slot int, runID string) error {
	b.record("netUp")
	b.mu.Lock()
	if b.slotsUp[slot] {
		b.mu.Unlock()
		return fmt.Errorf("slot %d is already in use", slot)
	}
	b.slotsUp[slot] = true
	b.mu.Unlock()
	if b.scriptFor(runID).NetUpFail {
		return fmt.Errorf("zsnet failed")
	}
	return nil
}

func (b *FakeBackend) NetDown(_ context.Context, slot int, _ string) error {
	b.record("netDown")
	b.mu.Lock()
	delete(b.slotsUp, slot)
	b.mu.Unlock()
	return nil
}

func (b *FakeBackend) Start(_ context.Context, o StartOptions) (VM, error) {
	b.record("start")
	script := b.scriptFor(o.RunID)
	if script.StartFail {
		return nil, newRunError(ReasonFcAPI, "PUT /boot-source returned 400")
	}
	vm := &FakeVM{b: b, script: script, exited: make(chan struct{}), pushes: make(chan pushItem, 1024)}
	b.mu.Lock()
	b.vms[vm] = true
	b.vmByRun[o.RunID] = vm
	if len(b.vms) > b.maxVMs {
		b.maxVMs = len(b.vms)
	}
	b.started = append(b.started, o.RunID)
	b.mu.Unlock()
	return vm, nil
}

func (b *FakeBackend) RemoveRunDir(runDir string) error {
	b.record("removeRunDir")
	b.mu.Lock()
	delete(b.dirs, runDir)
	b.mu.Unlock()
	return nil
}

func (b *FakeBackend) RecoverHost(context.Context) error {
	b.mu.Lock()
	b.recovered++
	b.mu.Unlock()
	return nil
}

func (b *FakeBackend) VM(runID string) *FakeVM {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.vmByRun[runID]
}

func (b *FakeBackend) Recovered() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.recovered
}

func (b *FakeBackend) MaxVMs() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.maxVMs
}

func (b *FakeBackend) Started() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.started...)
}

func (b *FakeBackend) LastJob() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lastJob
}

// AssertClean fails the test if anything was left behind once the supervisor is idle.
func (b *FakeBackend) AssertClean(t testing.TB) {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.slotsUp) > 0 || len(b.dirs) > 0 || len(b.vms) > 0 {
		t.Fatalf("leak: slots=%v dirs=%v vms=%d", b.slotsUp, b.dirs, len(b.vms))
	}
}

// ---- harness -------------------------------------------------------------------------------------------------

type Harness struct {
	Sup     *Supervisor
	Store   *Store
	Results *ResultFiles
	Backend *FakeBackend
	Config  Config
	Dir     string

	logMu sync.Mutex
	logs  []string
}

func (h *Harness) Logs() []string {
	h.logMu.Lock()
	defer h.logMu.Unlock()
	return append([]string(nil), h.logs...)
}

func makeConfig(t testing.TB, dir string, mutate func(*Config)) Config {
	t.Helper()
	cfg, err := LoadConfig(map[string]string{"SUP_STATE_DIR": dir, "SUP_IMAGE_DIR": filepath.Join(dir, "images"), "SUP_SOCKET": filepath.Join(dir, "sup.sock")})
	if err != nil {
		t.Fatal(err)
	}
	cfg.BootTimeout = 150 * time.Millisecond
	cfg.HardTimeout = time.Second
	cfg.QueueWait = 5 * time.Second
	cfg.ShutdownGrace = 150 * time.Millisecond
	cfg.Keepalive = 50 * time.Millisecond
	if mutate != nil {
		mutate(&cfg)
	}
	return cfg
}

// newHarness builds a supervisor on a fake host. scripts maps the URL path of a run to what the host does for it;
// "*" is the default.
func newHarness(t testing.TB, scripts map[string]Script, mutate func(*Config), tweak ...func(*Deps)) *Harness {
	t.Helper()
	return newHarnessIn(t, t.TempDir(), scripts, mutate, tweak...)
}

func newHarnessIn(t testing.TB, dir string, scripts map[string]Script, mutate func(*Config), tweak ...func(*Deps)) *Harness {
	t.Helper()
	cfg := makeConfig(t, dir, mutate)
	store, problems := NewStore(cfg.RecordsDir)
	if len(problems) > 0 {
		t.Fatalf("store: %v", problems)
	}
	results, err := NewResultFiles(cfg.ResultsDir)
	if err != nil {
		t.Fatal(err)
	}
	h := &Harness{Store: store, Results: results, Config: cfg, Dir: dir}
	h.Backend = newFakeBackend(func(id string) Script {
		rec, ok := store.Get(id)
		path := ""
		if ok {
			if u, err := url.Parse(rec.URL); err == nil {
				path = u.Path
			}
		}
		if s, ok := scripts[path]; ok {
			return s
		}
		return scripts["*"]
	})
	log := func(level, msg string, fields map[string]any) {
		b, _ := json.Marshal(merge(map[string]any{"level": level, "msg": msg}, fields))
		h.logMu.Lock()
		h.logs = append(h.logs, string(b))
		h.logMu.Unlock()
	}
	deps := Deps{Config: cfg, Store: store, Results: results, Backend: h.Backend, Log: log, SweepEvery: 20 * time.Millisecond}
	for _, f := range tweak {
		f(&deps)
	}
	h.Sup = NewSupervisor(deps)
	t.Cleanup(h.Sup.Shutdown)
	return h
}

func (h *Harness) start(t testing.TB) {
	t.Helper()
	if err := h.Sup.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func urlOf(path string) string { return "https://example.test" + path }

func (h *Harness) submit(t testing.TB, path string) string {
	t.Helper()
	res, err := h.Sup.Submit(urlOf(path), nil)
	if err != nil {
		t.Fatal(err)
	}
	return res.RunID
}

func (h *Harness) submitSession(t testing.TB, path string, lim SessionLimits) string {
	t.Helper()
	res, err := h.Sup.Submit(urlOf(path), &lim)
	if err != nil {
		t.Fatal(err)
	}
	return res.RunID
}

func (h *Harness) state(id string) RunState {
	v, ok := h.Sup.Get(id)
	if !ok {
		return ""
	}
	return v.State
}

// finished waits for a terminal state and returns the view.
func (h *Harness) finished(t testing.TB, id string, limit ...time.Duration) RunView {
	t.Helper()
	var v RunView
	waitFor(t, "run "+id[:8]+" to finish", func() bool {
		got, ok := h.Sup.Get(id)
		if ok && got.State.Terminal() {
			v = got
			return true
		}
		return false
	}, limit...)
	return v
}

func (h *Harness) waitState(t testing.TB, id string, want RunState, limit ...time.Duration) {
	t.Helper()
	waitFor(t, fmt.Sprintf("run %s to reach %s", id[:8], want), func() bool { return h.state(id) == want }, limit...)
}

// idle waits until nothing runs and nothing is left behind on the (fake) host.
func (h *Harness) idle(t testing.TB) {
	t.Helper()
	waitFor(t, "no run in progress", func() bool { return h.Sup.Health().Running == 0 })
	h.Backend.AssertClean(t)
}

func (h *Harness) events(id string) []RunEvent { return h.Results.Read(id, 0) }

func (h *Harness) states(id string) []string {
	var out []string
	for _, e := range h.events(id) {
		if e.Type == "state" {
			var s struct {
				State string `json:"state"`
			}
			_ = json.Unmarshal([]byte(e.Data), &s)
			out = append(out, s.State)
		}
	}
	return out
}

// dedupe removes repeated entries, keeping the first occurrence of each (like awk '!seen[$0]++').
func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func (h *Harness) evidence(id string) []string {
	var out []string
	for _, e := range h.events(id) {
		if e.Type == "evidence" {
			out = append(out, e.Data)
		}
	}
	return out
}

// commandEvents returns the decoded command events of a run.
func (h *Harness) commandEvents(id string) []CommandEvent {
	var out []CommandEvent
	for _, e := range h.events(id) {
		if e.Type == "command" {
			var c CommandEvent
			if json.Unmarshal([]byte(e.Data), &c) == nil {
				out = append(out, c)
			}
		}
	}
	return out
}

// statusesOf lists the statuses a command went through.
func (h *Harness) statusesOf(id, commandID string) []string {
	var out []string
	for _, c := range h.commandEvents(id) {
		if c.CommandID == commandID {
			out = append(out, string(c.Status))
		}
	}
	return out
}

// ---- HTTP ----------------------------------------------------------------------------------------------------

// withAPI serves the API on a loopback port for the duration of fn. The supervisor is started first.
func withAPI(t testing.TB, h *Harness, fn func(base string)) {
	t.Helper()
	h.start(t)
	srv := httptest.NewServer(NewAPI(h.Sup, h.Config, nullLogger))
	defer func() {
		h.Sup.Shutdown()
		srv.CloseClientConnections()
		srv.Close()
	}()
	fn(srv.URL)
}

func call(t testing.TB, base, method, path string, body any) (int, string) {
	t.Helper()
	status, text, _ := callH(t, base, method, path, body)
	return status, text
}

func callH(t testing.TB, base, method, path string, body any) (int, string, http.Header) {
	t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		rd = strings.NewReader(string(raw))
	}
	req, err := http.NewRequest(method, base+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), resp.Header
}

type sseEvent struct {
	ID    int
	Event string
	Data  string
}

// readSSE reads a stream that the server ends by itself (a terminal state).
func readSSE(t testing.TB, url string, headers map[string]string) []sseEvent {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("SSE status %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("content-type %q", resp.Header.Get("Content-Type"))
	}
	b, _ := io.ReadAll(resp.Body)
	var out []sseEvent
	for _, frame := range strings.Split(string(b), "\n\n") {
		if !strings.HasPrefix(frame, "id:") {
			continue
		}
		var ev sseEvent
		fmt.Sscanf(frame, "id: %d\n", &ev.ID)
		for _, line := range strings.Split(frame, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				ev.Event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.Data = strings.TrimPrefix(line, "data: ")
			}
		}
		out = append(out, ev)
	}
	return out
}
