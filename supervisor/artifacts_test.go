package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---- helpers -------------------------------------------------------------------------------------------------

func pngBytes(n int) []byte {
	return append(append([]byte(nil), pngMagic...), bytes.Repeat([]byte{0x42}, n)...)
}

// nameOf is the name the collector gives a file: 16 hex digits of the SHA-256 and the extension.
func nameOf(data []byte, ext string) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:16] + "." + ext
}

func fullSHA(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// announce is the artifact event of the collector. Fields can be overridden to lie.
func announce(file string, bytesN int, over map[string]any) string {
	m := map[string]any{"type": "evidence", "v": 1, "kind": "artifact", "id": "x", "file": file, "name": "screenshot.png",
		"bytes": bytesN, "sha256": strings.Repeat("0", 64), "mime": "image/png", "saved": true}
	for k, v := range over {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func withArtifacts(t testing.TB, dir string) func(*Deps) {
	t.Helper()
	af, err := NewArtifactFiles(filepath.Join(dir, "artifacts"))
	if err != nil {
		t.Fatal(err)
	}
	return func(d *Deps) { d.Artifacts = af }
}

// artifactHarness runs one scripted run to the end and returns the harness and the run id.
func artifactHarness(t *testing.T, sc Script, mutate func(*Config)) (*Harness, string) {
	t.Helper()
	dir := t.TempDir()
	h := newHarnessIn(t, dir, map[string]Script{"*": sc}, mutate, withArtifacts(t, dir))
	h.start(t)
	id := h.submit(t, "/")
	h.finished(t, id)
	h.idle(t)
	return h, id
}

func artifactEvents(h *Harness, id string) []ArtifactInfo {
	var out []ArtifactInfo
	for _, e := range h.events(id) {
		if e.Type == "artifact" {
			var a ArtifactInfo
			if err := json.Unmarshal([]byte(e.Data), &a); err != nil {
				panic(err)
			}
			out = append(out, a)
		}
	}
	return out
}

func storedFiles(h *Harness, id string) []string {
	entries, _ := os.ReadDir(filepath.Join(h.Config.ArtifactsDir, id))
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// ---- the supervisor fetches and publishes --------------------------------------------------------------------

func TestArtifactIsFetchedVerifiedAndPublished(t *testing.T) {
	data := pngBytes(5000)
	name := nameOf(data, "png")
	h, id := artifactHarness(t, Script{
		Lines:     []string{announce(name, len(data), nil), okStatus},
		Artifacts: map[string][]byte{name: data},
	}, nil)

	got := artifactEvents(h, id)
	if len(got) != 1 {
		t.Fatalf("artifact events: %+v", got)
	}
	a := got[0]
	if !a.Saved || a.Name != name || a.Bytes != int64(len(data)) || a.SHA256 != fullSHA(data) || a.Mime != "image/png" {
		t.Fatalf("published: %+v", a)
	}
	if a.SHA256 == strings.Repeat("0", 64) {
		t.Fatal("the collector's claimed hash was passed on instead of the measured one")
	}
	stored, err := os.ReadFile(filepath.Join(h.Config.ArtifactsDir, id, name))
	if err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("stored file: %v", err)
	}
	if files := storedFiles(h, id); len(files) != 1 {
		t.Fatalf("leftovers: %v", files)
	}
	// the event comes before the run's terminal state: a consumer that waits for "done" sees every artifact
	last := ""
	artIdx, doneIdx := -1, -1
	for i, e := range h.events(id) {
		if e.Type == "artifact" {
			artIdx = i
		}
		if e.Type == "state" && strings.Contains(e.Data, `"done"`) {
			doneIdx = i
		}
		last = e.Type
	}
	if artIdx < 0 || doneIdx < 0 || artIdx > doneIdx || last != "state" {
		t.Fatalf("order: artifact at %d, done at %d, last %s", artIdx, doneIdx, last)
	}
}

func TestArtifactThatDoesNotMatchItsNameIsRefused(t *testing.T) {
	data := pngBytes(100)
	other := pngBytes(101)
	name := nameOf(other, "png") // the name belongs to different content
	h, id := artifactHarness(t, Script{
		Lines:     []string{announce(name, len(data), nil), okStatus},
		Artifacts: map[string][]byte{name: data},
	}, nil)
	got := artifactEvents(h, id)
	if len(got) != 1 || got[0].Saved || got[0].Error != ArtMismatch {
		t.Fatalf("got %+v", got)
	}
	if files := storedFiles(h, id); len(files) != 0 {
		t.Fatalf("a refused file was kept: %v", files)
	}
}

func TestPngThatIsNotAPngIsRefused(t *testing.T) {
	data := []byte("<html><script>alert(1)</script></html>")
	name := nameOf(data, "png")
	h, id := artifactHarness(t, Script{
		Lines:     []string{announce(name, len(data), nil), okStatus},
		Artifacts: map[string][]byte{name: data},
	}, nil)
	got := artifactEvents(h, id)
	if len(got) != 1 || got[0].Saved || got[0].Error != ArtNotPNG {
		t.Fatalf("got %+v", got)
	}
	if files := storedFiles(h, id); len(files) != 0 {
		t.Fatalf("kept: %v", files)
	}
}

func TestBinaryArtifactNeedsNoMagic(t *testing.T) {
	data := []byte("MZ whatever the page served")
	name := nameOf(data, "bin")
	h, id := artifactHarness(t, Script{
		Lines:     []string{announce(name, len(data), map[string]any{"mime": "application/x-msdownload", "name": "setup.exe"}), okStatus},
		Artifacts: map[string][]byte{name: data},
	}, nil)
	got := artifactEvents(h, id)
	if len(got) != 1 || !got[0].Saved || got[0].Mime != "application/octet-stream" {
		t.Fatalf("got %+v (the type is decided by the host, not by the page)", got)
	}
}

func TestArtifactLargerThanAnnouncedIsRefused(t *testing.T) {
	data := pngBytes(5000)
	name := nameOf(data, "png")
	h, id := artifactHarness(t, Script{
		Lines:     []string{announce(name, 100, nil), okStatus}, // the collector says 100 bytes
		Artifacts: map[string][]byte{name: data},
	}, nil)
	got := artifactEvents(h, id)
	if len(got) != 1 || got[0].Saved || got[0].Error != ArtTooLarge {
		t.Fatalf("got %+v", got)
	}
}

func TestArtifactMissingInTheGuest(t *testing.T) {
	name := nameOf([]byte("never written"), "bin")
	h, id := artifactHarness(t, Script{Lines: []string{announce(name, 13, nil), okStatus}}, nil)
	got := artifactEvents(h, id)
	if len(got) != 1 || got[0].Saved || got[0].Error != ArtNotInGuest {
		t.Fatalf("got %+v", got)
	}
}

func TestAnnouncementsThatCannotBeTrustedAreIgnored(t *testing.T) {
	data := pngBytes(50)
	good := nameOf(data, "png")
	lines := []string{
		announce("../../etc/passwd", 50, nil),
		announce("/etc/passwd", 50, nil),
		announce(strings.ToUpper(good), 50, nil),
		announce(good+"/x", 50, nil),
		announce("0123456789abcdef.exe", 50, nil),
		announce(good, 0, nil),
		announce(good, -5, nil),
		announce(good, 1<<40, nil),
		announce(good, 50, map[string]any{"bytes": "50"}),
		announce(good, 50, map[string]any{"bytes": 50.5}),
		announce(good, 50, map[string]any{"saved": false, "error": "artifact_limit"}),
		announce(good, 50, map[string]any{"file": 7}),
		strings.Replace(announce(good, 50, nil), `"evidence"`, `"status"`, 1),
		okStatus,
	}
	h, id := artifactHarness(t, Script{Lines: lines, Artifacts: map[string][]byte{good: data, "../../etc/passwd": data}}, nil)
	if got := artifactEvents(h, id); len(got) != 0 {
		t.Fatalf("nothing should have been fetched, got %+v", got)
	}
	if files := storedFiles(h, id); len(files) != 0 {
		t.Fatalf("files: %v", files)
	}
	// the announcements themselves are still evidence (the raw lines are published unchanged)
	if n := len(h.evidence(id)); n < 10 {
		t.Fatalf("evidence lines: %d", n)
	}
}

func TestAnnouncedTwiceIsFetchedOnce(t *testing.T) {
	data := pngBytes(64)
	name := nameOf(data, "png")
	a := announce(name, len(data), nil)
	h, id := artifactHarness(t, Script{Lines: []string{a, a, a, okStatus}, Artifacts: map[string][]byte{name: data}}, nil)
	if got := artifactEvents(h, id); len(got) != 1 || !got[0].Saved {
		t.Fatalf("got %+v", got)
	}
}

func TestArtifactCountLimit(t *testing.T) {
	var lines []string
	files := map[string][]byte{}
	for i := 0; i < 5; i++ {
		d := pngBytes(10 + i)
		n := nameOf(d, "png")
		files[n] = d
		lines = append(lines, announce(n, len(d), nil))
	}
	h, id := artifactHarness(t, Script{Lines: append(lines, okStatus), Artifacts: files}, func(c *Config) { c.MaxArtifacts = 3 })
	saved, refused := 0, 0
	for _, a := range artifactEvents(h, id) {
		switch {
		case a.Saved:
			saved++
		case a.Error == ArtLimit:
			refused++
		}
	}
	if saved != 3 || refused != 2 {
		t.Fatalf("saved %d, refused %d", saved, refused)
	}
	if files := storedFiles(h, id); len(files) != 3 {
		t.Fatalf("stored: %v", files)
	}
}

func TestArtifactTotalSizeLimit(t *testing.T) {
	a, b := pngBytes(600), pngBytes(601)
	na, nb := nameOf(a, "png"), nameOf(b, "png")
	h, id := artifactHarness(t, Script{
		Lines:     []string{announce(na, len(a), nil), announce(nb, len(b), nil), okStatus},
		Artifacts: map[string][]byte{na: a, nb: b},
	}, func(c *Config) { c.MaxArtifactBytes = 1000 })
	got := artifactEvents(h, id)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	var okN, limN int
	for _, e := range got {
		if e.Saved {
			okN++
		} else if e.Error == ArtLimit {
			limN++
		}
	}
	if okN != 1 || limN != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestWithoutArtifactStoreNothingIsFetched(t *testing.T) {
	data := pngBytes(30)
	name := nameOf(data, "png")
	h := newHarness(t, map[string]Script{"*": {Lines: []string{announce(name, len(data), nil), okStatus}, Artifacts: map[string][]byte{name: data}}}, nil)
	h.start(t)
	id := h.submit(t, "/")
	h.finished(t, id)
	h.idle(t)
	if got := artifactEvents(h, id); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestSlowFetchIsAbortedWithTheRun(t *testing.T) {
	data := pngBytes(64)
	name := nameOf(data, "png")
	dir := t.TempDir()
	h := newHarnessIn(t, dir, map[string]Script{"*": {
		Lines: []string{announce(name, len(data), nil)}, Hang: true,
		Artifacts: map[string][]byte{name: data}, FetchDelay: time.Hour,
	}}, nil, withArtifacts(t, dir))
	h.start(t)
	id := h.submit(t, "/")
	h.waitState(t, id, StateRunning)
	waitFor(t, "the fetch to start", func() bool { return len(h.evidence(id)) >= 1 })
	start := time.Now()
	h.Sup.Cancel(id)
	v := h.finished(t, id)
	if time.Since(start) > 2*time.Second {
		t.Fatalf("cancel took %v", time.Since(start))
	}
	if v.State != StateFailed || v.Reason == nil || *v.Reason != ReasonCancelled {
		t.Fatalf("got %s/%v", v.State, v.Reason)
	}
	h.idle(t)
	if files := storedFiles(h, id); len(files) != 0 {
		t.Fatalf("a half-fetched file stayed: %v", files)
	}
}

func TestFetchesFinishBeforeTheVMIsStopped(t *testing.T) {
	data := pngBytes(64)
	name := nameOf(data, "png")
	h, id := artifactHarness(t, Script{
		Lines: []string{announce(name, len(data), nil), okStatus}, Artifacts: map[string][]byte{name: data},
		FetchDelay: 150 * time.Millisecond, // the job ends first; the fetch is still going
	}, nil)
	if got := artifactEvents(h, id); len(got) != 1 || !got[0].Saved {
		t.Fatalf("got %+v", got)
	}
}

func TestExpiryRemovesArtifacts(t *testing.T) {
	data := pngBytes(64)
	name := nameOf(data, "png")
	now := int64(1_000_000)
	dir := t.TempDir()
	h := newHarnessIn(t, dir, map[string]Script{"*": {Lines: []string{announce(name, len(data), nil), okStatus}, Artifacts: map[string][]byte{name: data}}},
		nil, withArtifacts(t, dir), func(d *Deps) { d.Now = func() int64 { return now } })
	h.start(t)
	id := h.submit(t, "/")
	h.finished(t, id)
	h.idle(t)
	if len(storedFiles(h, id)) != 1 {
		t.Fatal("nothing stored")
	}
	now += int64(h.Config.ResultTTL/time.Millisecond) + 1000
	h.Sup.mu.Lock()
	h.Sup.removeExpiredLocked()
	h.Sup.mu.Unlock()
	if _, err := os.Stat(filepath.Join(h.Config.ArtifactsDir, id)); !os.IsNotExist(err) {
		t.Fatalf("directory still there: %v", err)
	}
}

// ---- the store ---------------------------------------------------------------------------------------------

func TestPutRefusesBadNamesAndIds(t *testing.T) {
	af, err := NewArtifactFiles(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	called := false
	fetch := func(w io.Writer, max int64) (int64, error) { called = true; return 0, nil }
	for _, name := range []string{"../x.png", "a.png", "0123456789abcdef.exe", ""} {
		if _, code := af.Put("11111111-1111-1111-1111-111111111111", name, 10, fetch); code == "" {
			t.Errorf("%q accepted", name)
		}
	}
	if _, code := af.Put("../../x", "0123456789abcdef.png", 10, fetch); code == "" {
		t.Error("a bad run id was accepted")
	}
	if called {
		t.Error("fetch ran for a refused name")
	}
	if _, _, ok := af.Open("11111111-1111-1111-1111-111111111111", "../../../etc/passwd"); ok {
		t.Error("Open accepted a path")
	}
}

// ---- the HTTP side -----------------------------------------------------------------------------------------

func TestArtifactIsServedWithSafeHeaders(t *testing.T) {
	png := pngBytes(300)
	bin := []byte("MZ binary")
	np, nb := nameOf(png, "png"), nameOf(bin, "bin")
	dir := t.TempDir()
	h := newHarnessIn(t, dir, map[string]Script{"*": {
		Lines: []string{announce(np, len(png), nil), announce(nb, len(bin), map[string]any{"mime": "text/html"}), okStatus}, Artifacts: map[string][]byte{np: png, nb: bin},
	}}, nil, withArtifacts(t, dir))
	withAPI(t, h, func(base string) {
		id := h.submit(t, "/")
		h.finished(t, id)
		h.idle(t)
		get := func(path string) (*http.Response, []byte) {
			resp, err := http.Get(base + path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			return resp, b
		}
		resp, body := get("/v1/runs/" + id + "/artifacts/" + np)
		if resp.StatusCode != 200 || !bytes.Equal(body, png) || resp.Header.Get("Content-Type") != "image/png" ||
			resp.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
			t.Fatalf("png: %d %v", resp.StatusCode, resp.Header)
		}
		resp, body = get("/v1/runs/" + id + "/artifacts/" + nb)
		if resp.StatusCode != 200 || !bytes.Equal(body, bin) || resp.Header.Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("bin: %d %v", resp.StatusCode, resp.Header)
		}
		for _, p := range []string{
			"/v1/runs/" + id + "/artifacts/0123456789abcdef.png",
			"/v1/runs/" + id + "/artifacts/..%2F..%2Fetc%2Fpasswd",
			"/v1/runs/" + id + "/artifacts/" + strings.ToUpper(np),
			"/v1/runs/11111111-1111-1111-1111-111111111111/artifacts/" + np,
			"/v1/runs/" + id + "/artifacts",
		} {
			if resp, _ := get(p); resp.StatusCode != 404 {
				t.Errorf("%s: %d", p, resp.StatusCode)
			}
		}
		resp2, err := http.Post(base+"/v1/runs/"+id+"/artifacts/"+np, "text/plain", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp2.Body.Close()
		if resp2.StatusCode != 405 {
			t.Errorf("POST: %d", resp2.StatusCode)
		}
	})
}

// ---- the wire protocol -------------------------------------------------------------------------------------

// fakeAgent speaks the handshake of Firecracker's vsock proxy and then runs handler on each connection.
func fakeAgent(t *testing.T, handler func(c net.Conn, req string)) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "v.sock")
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
			go func() {
				defer c.Close()
				br := bufio.NewReader(c)
				if _, err := br.ReadString('\n'); err != nil { // CONNECT <port>
					return
				}
				_, _ = io.WriteString(c, "OK 1\n")
				req, err := br.ReadString('\n')
				if err != nil {
					return
				}
				handler(c, req)
			}()
		}
	}()
	return sock
}

func TestFetchOverTheWire(t *testing.T) {
	payload := bytes.Repeat([]byte("0123456789"), 10_000)
	ok := func(c net.Conn, req string) {
		if !strings.Contains(req, `"op":"artifact"`) || !strings.Contains(req, `"name":"0123456789abcdef.bin"`) {
			_, _ = io.WriteString(c, `{"type":"artifact","ok":false,"error":"bad_name"}`+"\n")
			return
		}
		_, _ = fmt.Fprintf(c, `{"type":"artifact","ok":true,"bytes":%d}`+"\n", len(payload))
		_, _ = c.Write(payload)
	}
	run := func(handler func(net.Conn, string), max int64, timeout time.Duration) (int64, []byte, error) {
		sock := fakeAgent(t, handler)
		var buf bytes.Buffer
		n, err := fetchAgentArtifact(context.Background(), sock, 5000, "0123456789abcdef.bin", &buf, max, timeout)
		return n, buf.Bytes(), err
	}

	if n, got, err := run(ok, 1<<20, 5*time.Second); err != nil || n != int64(len(payload)) || !bytes.Equal(got, payload) {
		t.Fatalf("good transfer: n=%d err=%v", n, err)
	}
	if _, got, err := run(ok, int64(len(payload))-1, 5*time.Second); err == nil || len(got) != 0 || fetchCode(err) != ArtTooLarge {
		t.Fatalf("above the cap: err=%v, %d bytes written", err, len(got))
	}
	if _, _, err := run(func(c net.Conn, _ string) {
		_, _ = io.WriteString(c, `{"type":"artifact","ok":false,"error":"not_found"}`+"\n")
	}, 100, time.Second); fetchCode(err) != ArtNotInGuest {
		t.Fatalf("not found: %v", err)
	}
	if _, _, err := run(func(c net.Conn, _ string) {
		_, _ = io.WriteString(c, `{"type":"artifact","ok":false,"error":"not_owned"}`+"\n")
	}, 100, time.Second); err == nil || fetchCode(err) != ArtFetch {
		t.Fatalf("refused: %v", err)
	}
	// hostile or broken replies
	for name, h := range map[string]func(net.Conn, string){
		"not json":       func(c net.Conn, _ string) { _, _ = io.WriteString(c, "hello\n") },
		"wrong type":     func(c net.Conn, _ string) { _, _ = io.WriteString(c, `{"type":"status","ok":true,"bytes":3}`+"\nabc") },
		"negative size":  func(c net.Conn, _ string) { _, _ = io.WriteString(c, `{"type":"artifact","ok":true,"bytes":-1}`+"\n") },
		"closes at once": func(c net.Conn, _ string) {},
		"short body": func(c net.Conn, _ string) {
			_, _ = io.WriteString(c, `{"type":"artifact","ok":true,"bytes":100}`+"\nonly ten b")
		},
		"no newline in the header": func(c net.Conn, _ string) { _, _ = c.Write(bytes.Repeat([]byte("x"), 200_000)) },
	} {
		if _, _, err := run(h, 1000, time.Second); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// a guest that sends the header and then stalls cannot hold the supervisor
	start := time.Now()
	_, _, err := run(func(c net.Conn, _ string) {
		_, _ = io.WriteString(c, `{"type":"artifact","ok":true,"bytes":100}`+"\nabc")
		time.Sleep(3 * time.Second)
	}, 1000, 300*time.Millisecond)
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("stall: err=%v after %v", err, time.Since(start))
	}
}

func TestFetchStopsWithItsContext(t *testing.T) {
	sock := fakeAgent(t, func(c net.Conn, _ string) {
		_, _ = io.WriteString(c, `{"type":"artifact","ok":true,"bytes":100}`+"\n")
		time.Sleep(5 * time.Second)
	})
	ctx, cancel := context.WithCancelCause(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel(newRunError(ReasonCancelled, ""))
	}()
	start := time.Now()
	_, err := fetchAgentArtifact(ctx, sock, 5000, "0123456789abcdef.bin", io.Discard, 1000, 30*time.Second)
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("err=%v after %v", err, time.Since(start))
	}
	if re := asRunError(err, ReasonInternal); re.Reason != ReasonCancelled {
		t.Fatalf("the cause was lost: %v", err)
	}
}
