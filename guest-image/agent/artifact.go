package main

// Artifact hand-over (spec 005, 3.6). The collector (unprivileged, and the part that touches hostile pages) writes
// files into the artifact directory. The host asks for one by name over a fresh connection:
//
//	client: {"op":"artifact","name":"<16 hex>.png|bin"}\n
//	agent:  {"type":"artifact","ok":true,"bytes":N}\n   then exactly N raw bytes, then close
//	        {"type":"artifact","ok":false,"error":"<code>"}\n   then close
//
// The agent runs as root and the directory belongs to the unprivileged user, so every step assumes that user is
// hostile: a fixed name shape (no path), no symbolic links, regular files only, owned by the collector user, size
// capped, and never more bytes than the size read from the open file.

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
)

var artifactNameRe = regexp.MustCompile(`^[0-9a-f]{16}\.(png|bin)$`)

const (
	defaultArtifactDir = "/run/zerostress/artifacts"
	defaultMaxArtifact = 32 << 20
	maxArtifactReaders = 2
)

// artifactRequest is the first line of a hand-over connection. Op is empty in a normal job.
type artifactRequest struct {
	Op   string `json:"op"`
	Name string `json:"name"`
}

type artifactReply struct {
	Type  string `json:"type"`
	OK    bool   `json:"ok"`
	Bytes int64  `json:"bytes,omitempty"`
	Error string `json:"error,omitempty"`
}

// deadlineWriter bounds every write, so a host that stops reading cannot hold the agent.
type deadlineWriter struct{ conn net.Conn }

func (w deadlineWriter) Write(p []byte) (int, error) {
	_ = w.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return w.conn.Write(p)
}

func (a *Agent) serveArtifact(conn net.Conn, name string) {
	refuse := func(code string) {
		writeJSONLine(conn, artifactReply{Type: "artifact", Error: code})
	}
	if !artifactNameRe.MatchString(name) {
		refuse("bad_name")
		return
	}
	if a.readers.Add(1) > maxArtifactReaders {
		a.readers.Add(-1)
		refuse("busy")
		return
	}
	defer a.readers.Add(-1)

	f, err := os.OpenFile(filepath.Join(a.cfg.ArtifactDir, name), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		refuse("not_found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		refuse("not_regular")
		return
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && a.cred != nil && sys.Uid != a.cred.Uid {
		refuse("not_owned") // a hard link to somebody else's file
		return
	}
	if st.Size() > a.cfg.MaxArtifact {
		refuse("too_large")
		return
	}
	n := st.Size()
	if !writeJSONLine(conn, artifactReply{Type: "artifact", OK: true, Bytes: n}) {
		return
	}
	// The file may still be growing or shrinking under us: exactly n bytes at most, and a short read just ends the
	// connection early, which the host sees as a size mismatch.
	if _, err := io.CopyN(deadlineWriter{conn}, f, n); err != nil && !errors.Is(err, io.EOF) {
		return
	}
}

func writeJSONLine(conn net.Conn, v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err = conn.Write(append(b, '\n'))
	return err == nil
}
