package main

import (
	"encoding/json"
	"io"
	"net/url"
	"os"
	"sync"
	"time"
)

// Logger writes one JSON object per line. Fields must not carry URLs or typed-in values: see URLInfo.
type Logger func(level, msg string, fields map[string]any)

var nullLogger Logger = func(string, string, map[string]any) {}

// NewLogger returns a logger that writes to w (stdout in the service).
func NewLogger(w io.Writer) Logger {
	var mu sync.Mutex
	return func(level, msg string, fields map[string]any) {
		line := map[string]any{"t": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "level": level, "msg": msg}
		for k, v := range fields {
			line[k] = v
		}
		b, err := json.Marshal(line)
		if err != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_, _ = w.Write(append(b, '\n'))
	}
}

func stdoutLogger() Logger { return NewLogger(os.Stdout) }

// URLInfo is what may be logged about a URL: it can carry personal tokens, so never the whole string.
func URLInfo(raw string) map[string]any {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return map[string]any{"len": len(raw)}
	}
	return map[string]any{"scheme": u.Scheme, "host": u.Hostname(), "len": len(raw)}
}
