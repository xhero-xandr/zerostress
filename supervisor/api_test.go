package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

const apiTGhost = "00000000-0000-4000-8000-000000000000"

func apiTPost(t testing.TB, base string, body any) (int, string, http.Header) {
	t.Helper()
	return callH(t, base, http.MethodPost, "/v1/runs", body)
}

func apiTMap(t testing.TB, text string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		t.Fatalf("not a JSON object: %q", text)
	}
	return m
}

// apiTSubmitURL submits a plain URL run and returns its id.
func apiTSubmitURL(t testing.TB, base, url string) string {
	t.Helper()
	status, text, _ := apiTPost(t, base, map[string]any{"kind": "url", "url": url})
	if status != 202 {
		t.Fatalf("submit %s = %d %s", url, status, text)
	}
	id, _ := apiTMap(t, text)["run_id"].(string)
	return id
}

func apiTDecode(t testing.TB, raw string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("bad test input %q: %v", raw, err)
	}
	return v
}

func TestAPI_ValidateSubmit_AcceptsHTTPAndRejectsEverythingElse(t *testing.T) {
	for _, raw := range []string{
		`{"kind":"url","url":"https://example.com/a?b=c"}`,
		`{"kind":"url","url":"http://example.com"}`,
	} {
		u, s, problem := ValidateSubmit(apiTDecode(t, raw))
		if problem != "" || s != nil || u == "" {
			t.Errorf("%s: got (%q, %v, %q)", raw, u, s, problem)
		}
	}
	bad := []string{
		`null`, `[]`, `"x"`, `{}`, `{"kind":"file","url":"https://a.b"}`, `{"kind":"url"}`, `{"kind":"url","url":""}`, `{"kind":"url","url":5}`,
		`{"kind":"url","url":"file:///etc/passwd"}`, `{"kind":"url","url":"file://example.com/etc/passwd"}`, `{"kind":"url","url":"javascript:alert(1)"}`, `{"kind":"url","url":"ftp://a.b"}`,
		`{"kind":"url","url":"data:text/html,hi"}`, `{"kind":"url","url":"https://a.b/ x"}`, `{"kind":"url","url":"https://a.b/\n"}`,
		`{"kind":"url","url":"not a url"}`, `{"kind":"url","url":"https://"}`,
		`{"kind":"url","url":"https://` + strings.Repeat("a", 2100) + `"}`,
		`{"kind":"url","url":"https://a.b","extra":1}`, `{"kind":"url","url":"https://a.b","limits":{"cpu":99}}`,
	}
	for _, raw := range bad {
		if _, _, problem := ValidateSubmit(apiTDecode(t, raw)); problem == "" {
			t.Errorf("accepted: %.80s", raw)
		}
	}
}

func TestAPI_PostRuns_AcceptedValidatedLimited(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.Concurrency = 1
		c.QueueMax = 1
		c.HardTimeout = 3 * time.Second
	})
	withAPI(t, h, func(base string) {
		status, text, _ := apiTPost(t, base, map[string]any{"kind": "url", "url": "https://example.test/a"})
		if status != 202 {
			t.Fatalf("first submit = %d %s", status, text)
		}
		a := apiTMap(t, text)
		runID, _ := a["run_id"].(string)
		if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(runID) {
			t.Fatalf("run_id = %q", runID)
		}
		if _, has := a["session"]; has {
			t.Errorf("a plain run answers with session: %s", text)
		}

		status, text, _ = apiTPost(t, base, map[string]any{"kind": "url", "url": "https://example.test/b"})
		if status != 202 || apiTMap(t, text)["position"] != float64(1) {
			t.Fatalf("second submit = %d %s", status, text)
		}

		status, text, hdr := apiTPost(t, base, map[string]any{"kind": "url", "url": "https://example.test/c"})
		if status != 429 || hdr.Get("retry-after") != "10" {
			t.Errorf("full queue = %d retry-after=%q", status, hdr.Get("retry-after"))
		}
		if apiTMap(t, text)["error"] != "queue is full" {
			t.Errorf("full queue body = %s", text)
		}

		status, text, _ = apiTPost(t, base, map[string]any{"kind": "file", "url": "x"})
		if status != 400 || apiTMap(t, text)["error"] == "" {
			t.Errorf("kind file = %d %s", status, text)
		}
		status, text, _ = apiTPost(t, base, "{not json")
		if status != 400 || apiTMap(t, text)["error"] != "body is not valid JSON" {
			t.Errorf("bad json = %d %s", status, text)
		}
		status, _, _ = apiTPost(t, base, `{"kind":"url","url":"file:///etc/passwd"}`)
		if status != 400 {
			t.Errorf("file: url = %d", status)
		}

		big := `{"kind":"url","url":"https://a.b/` + strings.Repeat("x", 70000) + `"}`
		req, _ := http.NewRequest(http.MethodPost, base+"/v1/runs", strings.NewReader(big))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("a client must get the 413, not a reset connection: %v", err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 413 {
			t.Errorf("oversize = %d", resp.StatusCode)
		}
		// net/http removes the Connection header from the map and reports it as Close
		if !resp.Close {
			t.Errorf("the 413 must carry Connection: close")
		}
		if apiTMap(t, string(b))["error"] != "request body too large" {
			t.Errorf("oversize body = %s", b)
		}

		status, _, hdr = callH(t, base, http.MethodGet, "/v1/runs", nil)
		if status != 405 || hdr.Get("allow") != "POST" {
			t.Errorf("GET /v1/runs = %d allow=%q", status, hdr.Get("allow"))
		}

		h.Sup.Cancel(runID)
		h.finished(t, runID)
	})
}

func TestAPI_BodyLimitBoundary(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, nil)
	withAPI(t, h, func(base string) {
		// exactly at the limit the body is read and judged on its content (invalid JSON here), one byte more is a 413
		status, _, _ := apiTPost(t, base, strings.Repeat(" ", 64*1024))
		if status != 400 {
			t.Errorf("64 KiB = %d, want 400", status)
		}
		status, _, _ = apiTPost(t, base, strings.Repeat(" ", 64*1024+1))
		if status != 413 {
			t.Errorf("64 KiB + 1 = %d, want 413", status)
		}
		// the same limit protects the command and approval endpoints
		status, _, _ = callH(t, base, http.MethodPost, "/v1/runs/"+apiTGhost+"/commands", strings.Repeat(" ", 64*1024+1))
		if status != 413 {
			t.Errorf("commands oversize = %d", status)
		}
		status, _, _ = callH(t, base, http.MethodPost, "/v1/runs/"+apiTGhost+"/approvals", strings.Repeat(" ", 64*1024+1))
		if status != 413 {
			t.Errorf("approvals oversize = %d", status)
		}
	})
}

func TestAPI_GetAndDeleteRun_UnknownIDsAndRoutes(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.Concurrency = 1
		c.HardTimeout = 3 * time.Second
	})
	withAPI(t, h, func(base string) {
		id := apiTSubmitURL(t, base, "https://example.test/x")
		h.waitState(t, id, StateRunning)

		status, text := call(t, base, http.MethodGet, "/v1/runs/"+id, nil)
		got := apiTMap(t, text)
		if status != 200 || got["state"] != "running" {
			t.Fatalf("GET run = %d %s", status, text)
		}
		if v, has := got["position"]; !has || v != nil {
			t.Errorf("position must be present and null: %s", text)
		}
		if _, has := got["url"]; has {
			t.Errorf("the view must not echo the URL: %s", text)
		}

		status, text = call(t, base, http.MethodDelete, "/v1/runs/"+id, nil)
		if status != 202 {
			t.Fatalf("DELETE = %d %s", status, text)
		}
		if m := apiTMap(t, text); m["run_id"] != id || m["result"] != "cancelling" {
			t.Errorf("DELETE body = %s", text)
		}
		h.finished(t, id)
		status, text = call(t, base, http.MethodDelete, "/v1/runs/"+id, nil)
		if status != 409 || apiTMap(t, text)["error"] != "run is already finished" {
			t.Errorf("second DELETE = %d %s", status, text)
		}

		expect := func(method, path string, want int, allow string) {
			t.Helper()
			status, _, hdr := callH(t, base, method, path, nil)
			if status != want {
				t.Errorf("%s %s = %d, want %d", method, path, status, want)
			}
			if got := hdr.Get("allow"); got != allow {
				t.Errorf("%s %s allow = %q, want %q", method, path, got, allow)
			}
		}
		expect(http.MethodGet, "/v1/runs/"+apiTGhost, 404, "")
		expect(http.MethodDelete, "/v1/runs/"+apiTGhost, 404, "")
		expect(http.MethodGet, "/v1/runs/not-an-id", 404, "")
		expect(http.MethodPost, "/v1/runs/"+id+"/events", 405, "GET")
		expect(http.MethodPatch, "/v1/runs/"+id, 405, "GET, DELETE")
		expect(http.MethodGet, "/other", 404, "")
		expect(http.MethodGet, "/", 404, "")
		expect(http.MethodGet, "/v1", 404, "")
		expect(http.MethodGet, "/v1/nothing", 404, "")
		expect(http.MethodGet, "/v1/health/extra", 404, "")
		expect(http.MethodGet, "/v1/runs/"+id+"/nothing", 404, "")
		expect(http.MethodGet, "/v1/runs/"+id+"/events/extra", 404, "")
	})
}

func TestAPI_SSE_LiveStreamEndsOnTerminalState_ReplayAndResume(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"a":1}`, `{"a":2}`, okStatus}, LineDelay: 40 * time.Millisecond}}, nil)
	withAPI(t, h, func(base string) {
		id := apiTSubmitURL(t, base, "https://example.test/s")
		events := base + "/v1/runs/" + id + "/events"

		live := readSSE(t, events, nil) // connects mid-run, must receive everything until the end
		if len(live) == 0 {
			t.Fatal("no events")
		}
		for i, e := range live {
			if e.ID != i+1 {
				t.Fatalf("event %d has id %d", i, e.ID)
			}
		}
		var last struct {
			State string `json:"state"`
		}
		if err := json.Unmarshal([]byte(live[len(live)-1].Data), &last); err != nil || last.State != "done" || live[len(live)-1].Event != "state" {
			t.Fatalf("last event = %+v", live[len(live)-1])
		}
		var evidence []string
		statuses := 0
		for _, e := range live {
			switch e.Event {
			case "evidence":
				evidence = append(evidence, e.Data)
			case "status":
				statuses++
			}
		}
		if !reflect.DeepEqual(evidence, []string{`{"a":1}`, `{"a":2}`}) || statuses != 1 {
			t.Errorf("evidence = %v, statuses = %d", evidence, statuses)
		}

		if again := readSSE(t, events, nil); !reflect.DeepEqual(again, live) {
			t.Errorf("replay differs:\n%v\n%v", again, live)
		}
		resumed := readSSE(t, events, map[string]string{"last-event-id": "4"})
		var wantIDs, gotIDs []int
		for _, e := range live {
			if e.ID > 4 {
				wantIDs = append(wantIDs, e.ID)
			}
		}
		for _, e := range resumed {
			gotIDs = append(gotIDs, e.ID)
		}
		if len(wantIDs) == 0 || !reflect.DeepEqual(gotIDs, wantIDs) {
			t.Errorf("resumed ids = %v, want %v", gotIDs, wantIDs)
		}
		if past := readSSE(t, events, map[string]string{"last-event-id": "9999"}); len(past) != 0 {
			t.Errorf("past the end: %v", past)
		}
		// a header that is not a plain number is ignored: the whole story is replayed
		for _, bad := range []string{"abc", "-1", "4x", ""} {
			if got := readSSE(t, events, map[string]string{"last-event-id": bad}); !reflect.DeepEqual(got, live) {
				t.Errorf("Last-Event-ID %q: %d events, want %d", bad, len(got), len(live))
			}
		}
		status, _ := call(t, base, http.MethodGet, "/v1/runs/"+apiTGhost+"/events", nil)
		if status != 404 {
			t.Errorf("events of an unknown run = %d", status)
		}
	})
}

func TestAPI_SSE_FramingHeadersKeepaliveAndTermination(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) { c.HardTimeout = 5 * time.Second })
	withAPI(t, h, func(base string) {
		id := apiTSubmitURL(t, base, "https://example.test/k")
		h.waitState(t, id, StateRunning)

		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/runs/"+id+"/events", nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("status %d", resp.StatusCode)
		}
		for k, want := range map[string]string{"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no"} {
			if got := resp.Header.Get(k); got != want {
				t.Errorf("%s = %q, want %q", k, got, want)
			}
		}

		br := bufio.NewReader(resp.Body)
		next := func() string {
			t.Helper()
			line, err := br.ReadString('\n')
			if err != nil {
				t.Fatalf("stream ended early: %v", err)
			}
			return line
		}
		if l := next(); l != "id: 1\n" {
			t.Fatalf("first line = %q", l)
		}
		if l := next(); l != "event: state\n" {
			t.Fatalf("second line = %q", l)
		}
		if l := next(); !strings.HasPrefix(l, "data: {") || !strings.HasSuffix(l, "}\n") {
			t.Fatalf("third line = %q", l)
		}
		if l := next(); l != "\n" {
			t.Fatalf("a frame ends with an empty line, got %q", l)
		}
		keepalives := 0
		for keepalives < 2 {
			l := next()
			if l == ":keepalive\n" {
				if nl := next(); nl != "\n" {
					t.Fatalf("keepalive is followed by %q", nl)
				}
				keepalives++
			}
		}

		h.Sup.Cancel(id)
		var rest strings.Builder
		for {
			line, err := br.ReadString('\n')
			rest.WriteString(line)
			if err != nil {
				if err != io.EOF {
					t.Fatalf("the stream must end cleanly after the terminal state: %v", err)
				}
				break
			}
		}
		if !strings.Contains(rest.String(), `"failed"`) || !strings.Contains(rest.String(), `"cancelled"`) {
			t.Errorf("the final state event is missing: %q", rest.String())
		}
	})
}

func TestAPI_SSE_CRAndLFCannotBreakFraming(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{"raw\rcarriage", "raw\nline", statusLine("exited_nonzero")}}}, nil)
	withAPI(t, h, func(base string) {
		id := apiTSubmitURL(t, base, "https://example.test/s")
		h.finished(t, id)
		var evidence []string
		for _, e := range readSSE(t, base+"/v1/runs/"+id+"/events", nil) {
			if e.Event == "evidence" {
				evidence = append(evidence, e.Data)
			}
		}
		if !reflect.DeepEqual(evidence, []string{`raw\rcarriage`, `raw\nline`}) {
			t.Errorf("evidence = %q", evidence)
		}
	})
}

func TestAPI_HealthReportsSlotsQueueAndImageChecksum(t *testing.T) {
	h := newHarness(t, nil, func(c *Config) { c.Concurrency = 2 }, func(d *Deps) {
		d.ImageSHA256 = func() string { return "abc123" }
		d.FreeGB = func() float64 { return 94.7 }
	})
	withAPI(t, h, func(base string) {
		status, text, hdr := callH(t, base, http.MethodGet, "/v1/health", nil)
		if status != 200 || hdr.Get("content-type") != "application/json" {
			t.Fatalf("health = %d %q", status, hdr.Get("content-type"))
		}
		var got map[string]any
		_ = json.Unmarshal([]byte(text), &got)
		want := map[string]any{
			"ok": true, "version": version, "concurrency": 2.0, "running": 0.0, "queued": 0.0,
			"sessions": map[string]any{"running": 0.0, "limit": 1.0}, "free_gb": 94.0, "image_sha256": "abc123",
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("health = %s", text)
		}
		status, _, hdr = callH(t, base, http.MethodPost, "/v1/health", nil)
		if status != 405 || hdr.Get("allow") != "GET" {
			t.Errorf("POST health = %d allow=%q", status, hdr.Get("allow"))
		}
	})
}

func TestAPI_HealthWithoutDiskAndImageInfoSaysNull(t *testing.T) {
	h := newHarness(t, nil, nil, func(d *Deps) {
		d.FreeGB = func() float64 { return math.Inf(1) }
		d.ImageSHA256 = func() string { return "" }
	})
	withAPI(t, h, func(base string) {
		_, text := call(t, base, http.MethodGet, "/v1/health", nil)
		got := apiTMap(t, text)
		for _, k := range []string{"free_gb", "image_sha256"} {
			if v, has := got[k]; !has || v != nil {
				t.Errorf("%s must be present and null: %s", k, text)
			}
		}
	})
}

func TestAPI_503WhileShuttingDown(t *testing.T) {
	h := newHarness(t, nil, nil)
	withAPI(t, h, func(base string) {
		h.Sup.Shutdown()
		status, text, hdr := apiTPost(t, base, map[string]any{"kind": "url", "url": "https://example.test/x"})
		if status != 503 || hdr.Get("retry-after") != "30" {
			t.Errorf("submit while draining = %d retry-after=%q", status, hdr.Get("retry-after"))
		}
		if apiTMap(t, text)["error"] != ErrDraining.Error() {
			t.Errorf("body = %s", text)
		}
	})
}

func TestAPI_503WhenTheDiskIsAlmostFull(t *testing.T) {
	h := newHarness(t, nil, func(c *Config) { c.MinFreeGB = 20 }, func(d *Deps) { d.FreeGB = func() float64 { return 5 } })
	withAPI(t, h, func(base string) {
		status, _, hdr := apiTPost(t, base, map[string]any{"kind": "url", "url": "https://example.test/x"})
		if status != 503 || hdr.Get("retry-after") != "30" {
			t.Errorf("low disk = %d retry-after=%q", status, hdr.Get("retry-after"))
		}
	})
}
