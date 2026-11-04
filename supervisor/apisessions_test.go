package main

import (
	"encoding/json"
	"math"
	"net/http"
	"reflect"
	"regexp"
	"testing"
	"time"
)

const apiSessTGhost = "99999999-9999-4999-8999-999999999999"

var apiSessTScript = Script{Lines: []string{`{"type":"evidence","v":1,"kind":"nav"}`, sessionReady}, Hang: true}

func apiSessTRunPath(id, rest string) string { return "/v1/runs/" + id + rest }

func apiSessTOpen(t testing.TB, base string, h *Harness, session any) string {
	t.Helper()
	status, text := call(t, base, http.MethodPost, "/v1/runs", map[string]any{"kind": "url", "url": "https://example.test/a", "session": session})
	if status != 202 {
		t.Fatalf("session submit = %d %s", status, text)
	}
	id, _ := apiTMap(t, text)["run_id"].(string)
	h.waitState(t, id, StateSession)
	return id
}

// apiSessTPostMap posts a JSON body and decodes the answer.
func apiSessTPostMap(t testing.TB, base, path string, body any) (int, map[string]any) {
	t.Helper()
	status, text := call(t, base, http.MethodPost, path, body)
	var m map[string]any
	_ = json.Unmarshal([]byte(text), &m)
	return status, m
}

func apiSessTInt(n int) *int { return &n }

func TestAPISessions_ValidateSubmit_SessionField(t *testing.T) {
	const url = "https://a.b/"
	run := func(session any, present bool) (string, *SessionRequest, string) {
		body := map[string]any{"kind": "url", "url": url}
		if present {
			body["session"] = session
		}
		return ValidateSubmit(body)
	}
	good := []struct {
		name    string
		session any
		present bool
		want    *SessionRequest
	}{
		{"empty object", map[string]any{}, true, &SessionRequest{}},
		{"both set", map[string]any{"idle_s": 5.0, "max_s": 600.0}, true, &SessionRequest{IdleS: apiSessTInt(5), MaxS: apiSessTInt(600)}},
		{"idle above max is allowed", map[string]any{"idle_s": 120.0, "max_s": 30.0}, true, &SessionRequest{IdleS: apiSessTInt(120), MaxS: apiSessTInt(30)}},
		{"no session field", nil, false, nil},
	}
	for _, c := range good {
		u, s, problem := run(c.session, c.present)
		if problem != "" || u != url || !reflect.DeepEqual(s, c.want) {
			t.Errorf("%s: got (%q, %+v, %q)", c.name, u, s, problem)
		}
	}
	bad := []struct {
		name string
		s    any
	}{
		{"true", true}, {"string", "yes"}, {"number", 5.0}, {"null", nil}, {"empty array", []any{}}, {"array", []any{1.0}},
		{"idle 4", map[string]any{"idle_s": 4.0}}, {"idle 121", map[string]any{"idle_s": 121.0}},
		{"max 29", map[string]any{"max_s": 29.0}}, {"max 601", map[string]any{"max_s": 601.0}},
		{"idle fraction", map[string]any{"idle_s": 1.5}}, {"idle fraction in range", map[string]any{"idle_s": 5.5}}, {"max fraction in range", map[string]any{"max_s": 30.5}}, {"max string", map[string]any{"max_s": "300"}},
		{"idle null", map[string]any{"idle_s": nil}}, {"max NaN", map[string]any{"max_s": math.NaN()}},
		{"max Inf", map[string]any{"max_s": math.Inf(1)}},
		{"unknown field", map[string]any{"cmd": "x"}}, {"extra field", map[string]any{"idle_s": 10.0, "extra": 1.0}},
	}
	for _, c := range bad {
		if _, _, problem := run(c.s, true); problem == "" {
			t.Errorf("%s accepted", c.name)
		}
	}
}

func TestAPISessions_PostWithSession_LimitsAppliedDefaultsFromConfiguration(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.SessionIdle = 20 * time.Second
		c.SessionMax = 200 * time.Second
	})
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{"idle_s": 30})
		_, text := call(t, base, http.MethodGet, "/v1/runs/"+id, nil)
		view := apiTMap(t, text)
		if !reflect.DeepEqual(view["session"], map[string]any{"idle_s": 30.0, "max_s": 200.0}) {
			t.Errorf("session = %v", view["session"])
		}
		if !reflect.DeepEqual(view["commands"], map[string]any{"total": 0.0, "awaiting_approval": 0.0}) {
			t.Errorf("commands = %v", view["commands"])
		}
		_, text = call(t, base, http.MethodPost, "/v1/runs", map[string]any{"kind": "url", "url": "https://example.test/b"})
		plain := apiTMap(t, text)
		if _, has := plain["session"]; has {
			t.Errorf("plain answer has session: %s", text)
		}
		status, _ := call(t, base, http.MethodPost, "/v1/runs", map[string]any{"kind": "url", "url": "https://example.test/c", "session": map[string]any{"max_s": 5}})
		if status != 400 {
			t.Errorf("max_s 5 = %d", status)
		}
		h.Sup.Cancel(id)
		h.Sup.Cancel(plain["run_id"].(string))
	})
}

func TestAPISessions_The202ForASessionRequestSaysSessionTrue(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) { c.BootTimeout = 300 * time.Millisecond })
	withAPI(t, h, func(base string) {
		status, body := apiSessTPostMap(t, base, "/v1/runs", map[string]any{"kind": "url", "url": "https://example.test/a", "session": map[string]any{}})
		if status != 202 || body["session"] != true {
			t.Fatalf("answer = %d %v", status, body)
		}
		h.Sup.Cancel(body["run_id"].(string))
	})
}

func TestAPISessions_RefusedWith503WhenSessionsAreSwitchedOff(t *testing.T) {
	h := newHarness(t, nil, func(c *Config) { c.SessionSlots = 0 })
	withAPI(t, h, func(base string) {
		status, text, hdr := callH(t, base, http.MethodPost, "/v1/runs", map[string]any{"kind": "url", "url": "https://example.test/a", "session": map[string]any{}})
		if status != 503 || hdr.Get("retry-after") != "30" {
			t.Errorf("session request = %d retry-after=%q", status, hdr.Get("retry-after"))
		}
		if apiTMap(t, text)["error"] != ErrSessionsDisabled.Error() {
			t.Errorf("body = %s", text)
		}
		status, _ = call(t, base, http.MethodPost, "/v1/runs", map[string]any{"kind": "url", "url": "https://example.test/a"})
		if status != 202 {
			t.Errorf("a plain run must still be accepted: %d", status)
		}
	})
}

func TestAPISessions_CommandsBeforeSessionReadyGet409NotSession(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Hang: true}}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.HardTimeout = 3 * time.Second
	})
	withAPI(t, h, func(base string) {
		status, body := apiSessTPostMap(t, base, "/v1/runs", map[string]any{"kind": "url", "url": "https://example.test/a", "session": map[string]any{}})
		if status != 202 {
			t.Fatalf("submit = %d", status)
		}
		id := body["run_id"].(string)
		status, early := apiSessTPostMap(t, base, apiSessTRunPath(id, "/commands"), map[string]any{"cmd": "snapshot", "id": "early"})
		if status != 409 || early["code"] != "not_session" {
			t.Errorf("early command = %d %v", status, early)
		}
		h.Sup.Cancel(id)
	})
}

func TestAPISessions_CommandsOverHTTP_AcceptedValidatedOneIDOnce(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) { c.BootTimeout = 300 * time.Millisecond })
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{})
		path := apiSessTRunPath(id, "/commands")
		status, body := apiSessTPostMap(t, base, path, map[string]any{"cmd": "scroll", "id": "s1", "dy": 100})
		if status != 202 || body["command_id"] != "s1" || body["status"] != "accepted" {
			t.Fatalf("scroll = %d %v", status, body)
		}
		if sha, _ := body["command_sha256"].(string); !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(sha) {
			t.Errorf("command_sha256 = %v", body["command_sha256"])
		}
		for _, bad := range []any{
			map[string]any{"cmd": "eval", "id": "x"}, map[string]any{"cmd": "scroll", "id": "x"}, map[string]any{"cmd": "scroll", "id": "x", "dy": 99999},
			[]any{}, "oops",
		} {
			status, text := call(t, base, http.MethodPost, path, bad)
			if status != 400 {
				t.Errorf("%v = %d %s", bad, status, text)
			}
		}
		if status, _ := call(t, base, http.MethodPost, path, "{not json"); status != 400 {
			t.Errorf("bad json = %d", status)
		}
		status, dup := apiSessTPostMap(t, base, path, map[string]any{"cmd": "snapshot", "id": "s1"})
		if status != 409 || dup["code"] != "duplicate_id" {
			t.Errorf("duplicate id = %d %v", status, dup)
		}
		h.Sup.Cancel(id)
	})
}

func TestAPISessions_RiskyCommand_HeldApprovalsValidatedOneTimeReachesGuestOnlyAfterApproval(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) { c.BootTimeout = 300 * time.Millisecond })
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{})
		vm := h.Backend.VM(id)
		status, d := apiSessTPostMap(t, base, apiSessTRunPath(id, "/commands"), map[string]any{"cmd": "download", "id": "dl", "snap": 1, "ref": "e2"})
		if status != 202 || d["status"] != "awaiting_approval" {
			t.Fatalf("download = %d %v", status, d)
		}
		sha, _ := d["command_sha256"].(string)
		if len(vm.Sent()) != 0 {
			t.Fatalf("a held command reached the guest: %v", vm.Sent())
		}

		approve := func(b any) (int, string) {
			t.Helper()
			return call(t, base, http.MethodPost, apiSessTRunPath(id, "/approvals"), b)
		}
		wrongHash := map[string]any{"command_id": "dl", "command_sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}
		refused := []struct {
			name string
			body any
			want int
		}{
			{"wrong hash", wrongHash, 409},
			{"no hash", map[string]any{"command_id": "dl"}, 400},
			{"hash not a string", map[string]any{"command_id": "dl", "command_sha256": 5}, 400},
			{"malformed command id", map[string]any{"command_id": "bad id!", "command_sha256": sha}, 400},
			{"missing command id", map[string]any{"command_sha256": sha}, 400},
			{"unknown field", map[string]any{"command_id": "dl", "command_sha256": sha, "force": true}, 400},
			{"array", []any{}, 400},
			{"unknown command", map[string]any{"command_id": "ghost", "command_sha256": sha}, 404},
		}
		for _, c := range refused {
			if status, text := approve(c.body); status != c.want {
				t.Errorf("%s = %d %s, want %d", c.name, status, text, c.want)
			}
		}
		if len(vm.Sent()) != 0 {
			t.Fatalf("a refused approval reached the guest: %v", vm.Sent())
		}

		status, text := approve(map[string]any{"command_id": "dl", "command_sha256": sha})
		if status != 202 || !reflect.DeepEqual(apiTMap(t, text), map[string]any{"command_id": "dl", "status": "approved"}) {
			t.Fatalf("approval = %d %s", status, text)
		}
		status, text = approve(map[string]any{"command_id": "dl", "command_sha256": sha})
		if status != 409 {
			t.Errorf("one-time: second approval = %d %s", status, text)
		}
		waitFor(t, "the approved command to reach the guest", func() bool { return len(vm.Sent()) == 1 })
		if got := vm.Sent()[0]; got != `{"cmd":"download","id":"dl","ref":"e2","snap":1}` {
			t.Errorf("sent = %s", got)
		}
		h.Sup.Cancel(id)
	})
}

func TestAPISessions_ApprovalWithTheHashOfAnotherCommandIsRefused(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) { c.BootTimeout = 300 * time.Millisecond })
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{})
		_, a := apiSessTPostMap(t, base, apiSessTRunPath(id, "/commands"), map[string]any{"cmd": "download", "id": "a", "snap": 1, "ref": "e1"})
		_, b := apiSessTPostMap(t, base, apiSessTRunPath(id, "/commands"), map[string]any{"cmd": "submit_form", "id": "b", "snap": 1, "form": "e2", "values": map[string]any{"e3": "x"}})
		status, r := apiSessTPostMap(t, base, apiSessTRunPath(id, "/approvals"), map[string]any{"command_id": "b", "command_sha256": a["command_sha256"]})
		if status != 409 || r["code"] != "hash_mismatch" {
			t.Errorf("approval with the wrong hash = %d %v", status, r)
		}
		if n := len(h.Backend.VM(id).Sent()); n != 0 {
			t.Errorf("%d lines reached the guest", n)
		}
		status, _ = apiSessTPostMap(t, base, apiSessTRunPath(id, "/approvals"), map[string]any{"command_id": "b", "command_sha256": b["command_sha256"]})
		if status != 202 {
			t.Errorf("approval with the right hash = %d", status)
		}
		h.Sup.Cancel(id)
	})
}

func TestAPISessions_RejectingWrongMethodsAndUnknownRuns(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) { c.BootTimeout = 300 * time.Millisecond })
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{})
		_, d := apiSessTPostMap(t, base, apiSessTRunPath(id, "/commands"), map[string]any{"cmd": "download", "id": "dl", "snap": 1, "ref": "e3"})

		status, text := call(t, base, http.MethodDelete, apiSessTRunPath(id, "/commands/dl"), nil)
		if status != 202 || !reflect.DeepEqual(apiTMap(t, text), map[string]any{"command_id": "dl", "status": "rejected"}) {
			t.Errorf("reject = %d %s", status, text)
		}
		expect := func(method, path string, body any, want int, allow string) {
			t.Helper()
			status, text, hdr := callH(t, base, method, path, body)
			if status != want {
				t.Errorf("%s %s = %d %s, want %d", method, path, status, text, want)
			}
			if got := hdr.Get("allow"); got != allow {
				t.Errorf("%s %s allow = %q, want %q", method, path, got, allow)
			}
		}
		expect(http.MethodDelete, apiSessTRunPath(id, "/commands/dl"), nil, 409, "")
		expect(http.MethodDelete, apiSessTRunPath(id, "/commands/nope"), nil, 404, "")
		expect(http.MethodDelete, apiSessTRunPath(id, "/commands/bad%20id"), nil, 404, "")
		expect(http.MethodPost, apiSessTRunPath(id, "/approvals"), map[string]any{"command_id": "dl", "command_sha256": d["command_sha256"]}, 409, "")

		expect(http.MethodGet, apiSessTRunPath(id, "/commands"), nil, 405, "POST")
		expect(http.MethodGet, apiSessTRunPath(id, "/approvals"), nil, 405, "POST")
		expect(http.MethodPost, apiSessTRunPath(id, "/commands/dl"), nil, 405, "DELETE")

		expect(http.MethodPost, apiSessTRunPath(apiSessTGhost, "/commands"), map[string]any{"cmd": "snapshot", "id": "a"}, 404, "")
		expect(http.MethodPost, apiSessTRunPath(apiSessTGhost, "/approvals"), map[string]any{"command_id": "a", "command_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, 404, "")
		expect(http.MethodDelete, apiSessTRunPath(apiSessTGhost, "/commands/a"), nil, 404, "")
		h.Sup.Cancel(id)
	})
}

func TestAPISessions_ApprovalThatCameTooLateGets410(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.ApprovalTTL = 40 * time.Millisecond
	})
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{"idle_s": 120})
		_, d := apiSessTPostMap(t, base, apiSessTRunPath(id, "/commands"), map[string]any{"cmd": "download", "id": "dl", "snap": 1, "ref": "e2"})
		time.Sleep(120 * time.Millisecond)
		status, late := apiSessTPostMap(t, base, apiSessTRunPath(id, "/approvals"), map[string]any{"command_id": "dl", "command_sha256": d["command_sha256"]})
		if status != 410 || late["code"] != "expired" {
			t.Errorf("late approval = %d %v", status, late)
		}
		if n := len(h.Backend.VM(id).Sent()); n != 0 {
			t.Errorf("%d lines reached the guest", n)
		}
		h.Sup.Cancel(id)
	})
}

func TestAPISessions_CloseEndsTheSession_StreamTellsTheWholeStory(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) { c.BootTimeout = 300 * time.Millisecond })
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{})
		cmds := apiSessTRunPath(id, "/commands")
		_, d := apiSessTPostMap(t, base, cmds, map[string]any{"cmd": "download", "id": "dl", "snap": 1, "ref": "e2"})
		status, _ := call(t, base, http.MethodPost, apiSessTRunPath(id, "/approvals"), map[string]any{"command_id": "dl", "command_sha256": d["command_sha256"]})
		if status != 202 {
			t.Fatalf("approval = %d", status)
		}
		call(t, base, http.MethodPost, cmds, map[string]any{"cmd": "download", "id": "dl2", "snap": 1, "ref": "e4"})
		if status, _ := call(t, base, http.MethodDelete, apiSessTRunPath(id, "/commands/dl2"), nil); status != 202 {
			t.Fatalf("reject = %d", status)
		}
		if status, _ := call(t, base, http.MethodPost, cmds, map[string]any{"cmd": "close", "id": "bye"}); status != 202 {
			t.Fatalf("close = %d", status)
		}

		if v := h.finished(t, id); v.State != StateDone {
			t.Fatalf("final state = %s", v.State)
		}
		if status, _ := call(t, base, http.MethodPost, cmds, map[string]any{"cmd": "snapshot", "id": "late"}); status != 409 {
			t.Errorf("command after the end = %d", status)
		}
		if status, _ := call(t, base, http.MethodPost, apiSessTRunPath(id, "/approvals"), map[string]any{"command_id": "dl", "command_sha256": d["command_sha256"]}); status != 409 {
			t.Errorf("approval after the end = %d", status)
		}

		events := readSSE(t, base+apiSessTRunPath(id, "/events"), nil)
		statuses := map[string][]string{}
		sawSession := false
		for _, e := range events {
			switch e.Event {
			case "command":
				var c struct {
					CommandID string `json:"command_id"`
					Status    string `json:"status"`
				}
				if err := json.Unmarshal([]byte(e.Data), &c); err != nil {
					t.Fatalf("command event %q: %v", e.Data, err)
				}
				statuses[c.CommandID] = append(statuses[c.CommandID], c.Status)
			case "state":
				if regexp.MustCompile(`"session"`).MatchString(e.Data) {
					sawSession = true
				}
			}
		}
		want := map[string][]string{
			"dl":  {"accepted", "awaiting_approval", "approved", "sent", "done"},
			"dl2": {"accepted", "awaiting_approval", "rejected"},
			"bye": {"accepted", "sent", "done"},
		}
		if !reflect.DeepEqual(statuses, want) {
			t.Errorf("command statuses = %v", statuses)
		}
		if !sawSession {
			t.Error("no state event for the session")
		}
		h.idle(t)
	})
}

func TestAPISessions_HealthListsTheSessionSlots(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": apiSessTScript}, func(c *Config) {
		c.BootTimeout = 300 * time.Millisecond
		c.SessionSlots = 1
	})
	withAPI(t, h, func(base string) {
		id := apiSessTOpen(t, base, h, map[string]any{})
		_, text := call(t, base, http.MethodGet, "/v1/health", nil)
		if got := apiTMap(t, text)["sessions"]; !reflect.DeepEqual(got, map[string]any{"running": 1.0, "limit": 1.0}) {
			t.Errorf("sessions = %v", got)
		}
		h.Sup.Cancel(id)
	})
}
