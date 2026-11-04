package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// Artifacts (spec 005, 3.6): files the collector saved in the guest, fetched by the supervisor over vsock while the VM
// is alive. Everything about a file that the guest says is a claim; what is published is what the host measured.

// artifactNameRe is the name the collector gives a file: the first 16 hex digits of its SHA-256 and a fixed extension.
var artifactNameRe = regexp.MustCompile(`^([0-9a-f]{16})\.(png|bin)$`)

var pngMagic = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// ArtifactInfo is what the supervisor publishes about a stored artifact.
type ArtifactInfo struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Mime   string `json:"mime"`
	Saved  bool   `json:"saved"`
	Error  string `json:"error,omitempty"`
}

func artifactMime(name string) string {
	if m := artifactNameRe.FindStringSubmatch(name); m != nil && m[2] == "png" {
		return "image/png"
	}
	return "application/octet-stream"
}

// Artifact failure codes, the only ones that ever reach an event (the guest's own text never does).
const (
	ArtLimit      = "artifact_limit"
	ArtFetch      = "fetch_failed"
	ArtMismatch   = "hash_mismatch"
	ArtNotPNG     = "not_png"
	ArtTooLarge   = "too_large"
	ArtNotInGuest = "not_found"
	ArtStore      = "store_failed"
)

// ArtifactFiles keeps the fetched files, one directory per run, next to the event log.
type ArtifactFiles struct{ dir string }

func NewArtifactFiles(dir string) (*ArtifactFiles, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &ArtifactFiles{dir: dir}, nil
}

func (f *ArtifactFiles) runDir(id string) (string, error) {
	if !validRunID(id) {
		return "", errors.New("invalid run id")
	}
	return filepath.Join(f.dir, id), nil
}

// Put fetches one artifact through fetch into a temporary file, checks it against its name and only then publishes it
// under that name. fetch writes at most max bytes.
func (f *ArtifactFiles) Put(runID, name string, max int64, fetch func(w io.Writer, max int64) (int64, error)) (ArtifactInfo, string) {
	m := artifactNameRe.FindStringSubmatch(name)
	dir, err := f.runDir(runID)
	if m == nil || err != nil {
		return ArtifactInfo{}, ArtStore
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ArtifactInfo{}, ArtStore
	}
	final := filepath.Join(dir, name)
	tmp := final + ".tmp"
	fh, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ArtifactInfo{}, ArtStore
	}
	committed := false
	defer func() {
		fh.Close()
		if !committed {
			_ = os.Remove(tmp)
		}
	}()
	h := sha256.New()
	head := &headWriter{max: len(pngMagic)}
	n, err := fetch(io.MultiWriter(fh, h, head), max)
	if err != nil {
		return ArtifactInfo{}, fetchCode(err)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if sum[:16] != m[1] {
		return ArtifactInfo{}, ArtMismatch
	}
	if m[2] == "png" && !bytes.Equal(head.b, pngMagic) {
		return ArtifactInfo{}, ArtNotPNG
	}
	if err := fh.Sync(); err != nil {
		return ArtifactInfo{}, ArtStore
	}
	if err := fh.Close(); err != nil {
		return ArtifactInfo{}, ArtStore
	}
	if err := os.Rename(tmp, final); err != nil {
		return ArtifactInfo{}, ArtStore
	}
	committed = true
	return ArtifactInfo{Name: name, Bytes: n, SHA256: sum, Mime: artifactMime(name), Saved: true}, ""
}

// Open returns a stored artifact for reading.
func (f *ArtifactFiles) Open(runID, name string) (*os.File, int64, bool) {
	dir, err := f.runDir(runID)
	if err != nil || !artifactNameRe.MatchString(name) {
		return nil, 0, false
	}
	fh, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return nil, 0, false
	}
	st, err := fh.Stat()
	if err != nil || !st.Mode().IsRegular() {
		fh.Close()
		return nil, 0, false
	}
	return fh, st.Size(), true
}

func (f *ArtifactFiles) Delete(runID string) {
	if dir, err := f.runDir(runID); err == nil {
		_ = os.RemoveAll(dir)
	}
}

// headWriter remembers the first max bytes written.
type headWriter struct {
	max int
	b   []byte
}

func (w *headWriter) Write(p []byte) (int, error) {
	if left := w.max - len(w.b); left > 0 {
		if len(p) < left {
			left = len(p)
		}
		w.b = append(w.b, p[:left]...)
	}
	return len(p), nil
}

type fetchError struct{ code string }

func (e *fetchError) Error() string { return e.code }

func fetchCode(err error) string {
	var fe *fetchError
	if errors.As(err, &fe) {
		return fe.code
	}
	return ArtFetch
}
