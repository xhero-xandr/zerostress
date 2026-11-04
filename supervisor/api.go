package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxBody = 64 * 1024
	maxURL  = 2048
)

// SessionRequest is the validated session field of a submit request; nil fields mean "use the default".
type SessionRequest struct {
	IdleS *int
	MaxS  *int
}

func wholeNumber(v any, min, max float64) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || f < min || f > max {
		return 0, false
	}
	return int(f), true
}

func validateSession(v any) (*SessionRequest, string) {
	o, ok := v.(map[string]any)
	if !ok {
		return nil, "session must be a JSON object"
	}
	for k := range o {
		if k != "idle_s" && k != "max_s" {
			return nil, "unknown session field: " + clip(k, 40)
		}
	}
	out := &SessionRequest{}
	if raw, present := o["idle_s"]; present {
		n, ok := wholeNumber(raw, 5, 120)
		if !ok {
			return nil, "session.idle_s must be an integer from 5 to 120"
		}
		out.IdleS = &n
	}
	if raw, present := o["max_s"]; present {
		n, ok := wholeNumber(raw, 30, 600)
		if !ok {
			return nil, "session.max_s must be an integer from 30 to 600"
		}
		out.MaxS = &n
	}
	return out, ""
}

// ValidateSubmit checks the shape of a submit request. Which hosts are acceptable (SSRF) is the gatekeeper's job in
// the web layer; the host firewall backs it up.
func ValidateSubmit(body any) (rawURL string, session *SessionRequest, problem string) {
	o, ok := body.(map[string]any)
	if !ok {
		return "", nil, "body must be a JSON object"
	}
	for k := range o {
		if k != "kind" && k != "url" && k != "session" {
			return "", nil, "unknown field: " + clip(k, 40)
		}
	}
	if o["kind"] != "url" {
		return "", nil, `kind must be "url"`
	}
	u, isStr := o["url"].(string)
	if !isStr || u == "" {
		return "", nil, "url must be a non-empty string"
	}
	if len(u) > maxURL {
		return "", nil, fmt.Sprintf("url is longer than %d characters", maxURL)
	}
	for _, r := range u {
		if r <= 0x20 || r == 0x7f {
			return "", nil, "url must not contain spaces or control characters"
		}
	}
	parsed, err := url.Parse(u)
	if err != nil || parsed.Scheme == "" {
		return "", nil, "url is not a valid absolute URL"
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", nil, "only http and https are allowed"
	}
	if parsed.Hostname() == "" {
		return "", nil, "url has no host"
	}
	if raw, present := o["session"]; present {
		s, problem := validateSession(raw)
		if problem != "" {
			return "", nil, problem
		}
		return u, s, ""
	}
	return u, nil, ""
}

func send(w http.ResponseWriter, status int, body any, headers ...string) {
	text := toJSON(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(text)))
	for i := 0; i+1 < len(headers); i += 2 {
		w.Header().Set(headers[i], headers[i+1])
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, text)
}

type errBody struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	send(w, http.StatusMethodNotAllowed, errBody{Error: "method not allowed"}, "Allow", allow)
}

// readJSON reads and parses a JSON body; on failure the error response has already been sent.
func readJSON(w http.ResponseWriter, r *http.Request) (any, bool) {
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		send(w, http.StatusBadRequest, errBody{Error: "unreadable body"})
		return nil, false
	}
	if len(b) > maxBody {
		send(w, http.StatusRequestEntityTooLarge, errBody{Error: "request body too large"}, "Connection", "close")
		return nil, false
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		send(w, http.StatusBadRequest, errBody{Error: "body is not valid JSON"})
		return nil, false
	}
	return v, true
}

var commandStatus = map[string]int{
	"not_found":     http.StatusNotFound,
	"bad_command":   http.StatusBadRequest,
	"not_session":   http.StatusConflict,
	"duplicate_id":  http.StatusConflict,
	"limit":         http.StatusTooManyRequests,
	"not_waiting":   http.StatusConflict,
	"hash_mismatch": http.StatusConflict,
	"expired":       http.StatusGone,
	"too_late":      http.StatusConflict,
}

func sendCmdError(w http.ResponseWriter, e *CmdError) {
	status, ok := commandStatus[e.Code]
	if !ok {
		status = http.StatusBadRequest
	}
	send(w, status, errBody{Error: e.Msg, Code: e.Code})
}

func sseFrame(ev RunEvent) string {
	// a raw CR or LF inside data would end the SSE field; JSON lines never contain them, anything else is neutralised
	data := strings.NewReplacer("\r", `\r`, "\n", `\n`).Replace(ev.Data)
	return fmt.Sprintf("id: %d\nevent: %s\ndata: %s\n\n", ev.Seq, ev.Type, data)
}

func isTerminalEvent(ev RunEvent) bool {
	if ev.Type != "state" {
		return false
	}
	var s struct {
		State RunState `json:"state"`
	}
	return json.Unmarshal([]byte(ev.Data), &s) == nil && s.State.Terminal()
}

// API is the HTTP interface of the supervisor (spec 006, section 5).
type API struct {
	sup *Supervisor
	cfg Config
	log Logger
}

func NewAPI(sup *Supervisor, cfg Config, log Logger) http.Handler {
	if log == nil {
		log = nullLogger
	}
	return &API{sup: sup, cfg: cfg, log: log}
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			a.log("error", "request failed", map[string]any{"detail": clip(fmt.Sprint(rec), 200)})
			send(w, http.StatusInternalServerError, errBody{Error: "internal error"})
		}
	}()
	var parts []string
	for _, p := range strings.Split(r.URL.Path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 || parts[0] != "v1" || len(parts) < 2 {
		send(w, http.StatusNotFound, errBody{Error: "not found"})
		return
	}
	switch {
	case parts[1] == "health" && len(parts) == 2:
		if r.Method != http.MethodGet {
			methodNotAllowed(w, "GET")
			return
		}
		send(w, http.StatusOK, a.sup.Health())
	case parts[1] == "runs" && len(parts) == 2:
		a.submit(w, r)
	case parts[1] == "runs" && len(parts) >= 3 && validRunID(parts[2]):
		a.run(w, r, parts[2], parts[3:])
	default:
		send(w, http.StatusNotFound, errBody{Error: "not found"})
	}
}

func (a *API) submit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, "POST")
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	u, sreq, problem := ValidateSubmit(body)
	if problem != "" {
		send(w, http.StatusBadRequest, errBody{Error: problem})
		return
	}
	var limits *SessionLimits
	if sreq != nil {
		limits = &SessionLimits{IdleMs: a.cfg.SessionIdle.Milliseconds(), MaxMs: a.cfg.SessionMax.Milliseconds()}
		if sreq.IdleS != nil {
			limits.IdleMs = int64(*sreq.IdleS) * 1000
		}
		if sreq.MaxS != nil {
			limits.MaxMs = int64(*sreq.MaxS) * 1000
		}
	}
	res, err := a.sup.Submit(u, limits)
	switch {
	case err == nil:
		res.Session = limits != nil
		send(w, http.StatusAccepted, res)
	case errors.Is(err, ErrQueueFull):
		send(w, http.StatusTooManyRequests, errBody{Error: "queue is full"}, "Retry-After", "10")
	case errors.Is(err, ErrDraining), errors.Is(err, ErrLowDisk), errors.Is(err, ErrSessionsDisabled):
		send(w, http.StatusServiceUnavailable, errBody{Error: err.Error()}, "Retry-After", "30")
	default:
		panic(err)
	}
}

func (a *API) run(w http.ResponseWriter, r *http.Request, id string, rest []string) {
	switch {
	case len(rest) == 0:
		switch r.Method {
		case http.MethodGet:
			if v, ok := a.sup.Get(id); ok {
				send(w, http.StatusOK, v)
			} else {
				send(w, http.StatusNotFound, errBody{Error: "not found"})
			}
		case http.MethodDelete:
			switch res := a.sup.Cancel(id); res {
			case "not_found":
				send(w, http.StatusNotFound, errBody{Error: "not found"})
			case "conflict":
				send(w, http.StatusConflict, errBody{Error: "run is already finished"})
			default:
				send(w, http.StatusAccepted, map[string]string{"run_id": id, "result": res})
			}
		default:
			methodNotAllowed(w, "GET, DELETE")
		}
	case len(rest) == 1 && rest[0] == "commands":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		body, ok := readJSON(w, r)
		if !ok {
			return
		}
		res, e := a.sup.SubmitCommand(id, body)
		if e != nil {
			sendCmdError(w, e)
			return
		}
		send(w, http.StatusAccepted, res)
	case len(rest) == 1 && rest[0] == "approvals":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		body, ok := readJSON(w, r)
		if !ok {
			return
		}
		o, isObj := body.(map[string]any)
		if !isObj {
			send(w, http.StatusBadRequest, errBody{Error: "body must be a JSON object"})
			return
		}
		for k := range o {
			if k != "command_id" && k != "command_sha256" {
				send(w, http.StatusBadRequest, errBody{Error: "unknown field: " + clip(k, 40)})
				return
			}
		}
		cid, _ := o["command_id"].(string)
		if !commandIDRe.MatchString(cid) {
			send(w, http.StatusBadRequest, errBody{Error: "command_id is missing or malformed"})
			return
		}
		sha, isStr := o["command_sha256"].(string)
		if !isStr {
			send(w, http.StatusBadRequest, errBody{Error: "command_sha256 must be a string"})
			return
		}
		if e := a.sup.ApproveCommand(id, cid, sha); e != nil {
			sendCmdError(w, e)
			return
		}
		send(w, http.StatusAccepted, map[string]string{"command_id": cid, "status": "approved"})
	case len(rest) == 2 && rest[0] == "commands":
		if r.Method != http.MethodDelete {
			methodNotAllowed(w, "DELETE")
			return
		}
		if !commandIDRe.MatchString(rest[1]) {
			send(w, http.StatusNotFound, errBody{Error: "not found"})
			return
		}
		if e := a.sup.RejectCommand(id, rest[1]); e != nil {
			sendCmdError(w, e)
			return
		}
		send(w, http.StatusAccepted, map[string]string{"command_id": rest[1], "status": "rejected"})
	case len(rest) == 2 && rest[0] == "artifacts":
		a.artifact(w, r, id, rest[1])
	case len(rest) == 1 && rest[0] == "events":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, "GET")
			return
		}
		if _, ok := a.sup.Get(id); !ok {
			send(w, http.StatusNotFound, errBody{Error: "not found"})
			return
		}
		a.events(w, r, id)
	default:
		send(w, http.StatusNotFound, errBody{Error: "not found"})
	}
}

// artifact serves one stored artifact of a run. The bytes come from a hostile page, so the response says what they are
// and forbids sniffing; a file is never shown as anything but its fixed type.
func (a *API) artifact(w http.ResponseWriter, r *http.Request, id, name string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, "GET")
		return
	}
	if _, ok := a.sup.Get(id); !ok || a.sup.artifacts == nil {
		send(w, http.StatusNotFound, errBody{Error: "not found"})
		return
	}
	fh, size, ok := a.sup.artifacts.Open(id, name)
	if !ok {
		send(w, http.StatusNotFound, errBody{Error: "not found"})
		return
	}
	defer fh.Close()
	w.Header().Set("Content-Type", artifactMime(name))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.CopyN(w, fh, size)
}

// events streams the run's events as SSE: the stored ones after Last-Event-ID, then live ones, until a terminal state.
func (a *API) events(w http.ResponseWriter, r *http.Request, id string) {
	after := 0
	if h := r.Header.Get("Last-Event-ID"); digitsRe.MatchString(h) {
		after, _ = strconv.Atoi(h)
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		send(w, http.StatusInternalServerError, errBody{Error: "streaming is not supported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fl.Flush()

	sub, ok := a.sup.Subscribe(id, after)
	if !ok {
		return
	}
	defer sub.Close()
	for _, ev := range sub.Replay {
		_, _ = io.WriteString(w, sseFrame(ev))
		if isTerminalEvent(ev) {
			fl.Flush()
			return
		}
	}
	if v, ok := a.sup.Get(id); !ok || v.State.Terminal() {
		fl.Flush()
		return
	}
	fl.Flush()
	tick := time.NewTicker(a.cfg.Keepalive)
	defer tick.Stop()
	for {
		select {
		case ev, ok := <-sub.Events:
			if !ok {
				return // dropped as too slow: the client reconnects with Last-Event-ID
			}
			if _, err := io.WriteString(w, sseFrame(ev)); err != nil {
				return
			}
			fl.Flush()
			if isTerminalEvent(ev) {
				return
			}
		case <-tick.C:
			if _, err := io.WriteString(w, ":keepalive\n\n"); err != nil {
				return
			}
			fl.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
