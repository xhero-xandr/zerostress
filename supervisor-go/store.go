package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var runIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func validRunID(id string) bool { return runIDRe.MatchString(id) }

// Store keeps one JSON file per run (written to a temporary name and renamed, so a reader or a crash never sees half a
// record) and an in-memory index. The standard library has no SQLite, and a queue of a few dozen runs needs nothing
// more. All methods are safe for concurrent use.
type Store struct {
	mu      sync.Mutex
	dir     string
	runs    map[string]*RunRecord
	nextSeq int64
}

// NewStore opens (and creates) the directory and loads every record in it. Unreadable files are reported, not fatal.
func NewStore(dir string) (*Store, []error) {
	s := &Store{dir: dir, runs: map[string]*RunRecord{}}
	var problems []error
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return s, []error{err}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return s, []error{err}
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			if strings.HasSuffix(name, ".tmp") {
				_ = os.Remove(filepath.Join(dir, name)) // a write that never finished
			}
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			problems = append(problems, err)
			continue
		}
		var rec RunRecord
		if err := json.Unmarshal(b, &rec); err != nil || !validRunID(rec.ID) || rec.ID+".json" != name {
			problems = append(problems, fmt.Errorf("record %s is damaged", name))
			continue
		}
		s.runs[rec.ID] = &rec
		if rec.Seq >= s.nextSeq {
			s.nextSeq = rec.Seq + 1
		}
	}
	return s, problems
}

func (s *Store) path(id string) string { return filepath.Join(s.dir, id+".json") }

// persist writes the record atomically. The caller holds the lock.
func (s *Store) persist(rec *RunRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	tmp := s.path(rec.ID) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path(rec.ID))
}

func (s *Store) Insert(rec RunRecord) error {
	if !validRunID(rec.ID) {
		return errors.New("invalid run id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec.State = StateQueued
	rec.Seq = s.nextSeq
	s.nextSeq++
	if err := s.persist(&rec); err != nil {
		return err
	}
	s.runs[rec.ID] = &rec
	return nil
}

// Get returns a copy of the record.
func (s *Store) Get(id string) (RunRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return RunRecord{}, false
	}
	return copyRecord(r), true
}

func copyRecord(r *RunRecord) RunRecord {
	c := *r
	if r.Slot != nil {
		v := *r.Slot
		c.Slot = &v
	}
	if r.StartedAt != nil {
		v := *r.StartedAt
		c.StartedAt = &v
	}
	if r.FinishedAt != nil {
		v := *r.FinishedAt
		c.FinishedAt = &v
	}
	if r.Session != nil {
		v := *r.Session
		c.Session = &v
	}
	return c
}

// Update applies fn to the record and stores the result.
func (s *Store) Update(id string, fn func(*RunRecord)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return errors.New("no such run")
	}
	fn(r)
	return s.persist(r)
}

func (s *Store) collect(keep func(*RunRecord) bool) []RunRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []RunRecord
	for _, r := range s.runs {
		if keep(r) {
			out = append(out, copyRecord(r))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].Seq < out[j].Seq
	})
	return out
}

// Queued returns the queued runs in arrival order.
func (s *Store) Queued() []RunRecord {
	return s.collect(func(r *RunRecord) bool { return r.State == StateQueued })
}

// InFlight returns the runs that were in progress when the process died.
func (s *Store) InFlight() []RunRecord {
	return s.collect(func(r *RunRecord) bool {
		switch r.State {
		case StatePreparing, StateBooting, StateRunning, StateSession, StateDestroying:
			return true
		}
		return false
	})
}

// Expired returns the ids of finished runs whose retention time has passed.
func (s *Store) Expired(now int64) []string {
	var ids []string
	for _, r := range s.collect(func(r *RunRecord) bool { return r.ExpiresAt <= now && r.State.Terminal() }) {
		ids = append(ids, r.ID)
	}
	return ids
}

func (s *Store) Delete(id string) {
	if !validRunID(id) {
		return // never build a path from anything but a run id
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.runs, id)
	_ = os.Remove(s.path(id))
}

// ResultFiles is the per-run event log: one JSON envelope per line. Evidence lines are stored as opaque strings and
// never parsed here.
type ResultFiles struct {
	mu  sync.Mutex
	dir string
}

func NewResultFiles(dir string) (*ResultFiles, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &ResultFiles{dir: dir}, nil
}

func (f *ResultFiles) path(id string) (string, error) {
	if !validRunID(id) {
		return "", errors.New("invalid run id")
	}
	return filepath.Join(f.dir, id+".ndjson"), nil
}

func (f *ResultFiles) Append(id string, ev RunEvent) error {
	p, err := f.path(id)
	if err != nil {
		return err
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	fh, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	line := append(b, '\n')
	// after a crash the last line may be torn; start on a fresh line so the new event is not glued onto the fragment
	if st, serr := fh.Stat(); serr == nil && st.Size() > 0 {
		var last [1]byte
		if _, rerr := fh.ReadAt(last[:], st.Size()-1); rerr == nil && last[0] != '\n' {
			line = append([]byte{'\n'}, line...)
		}
	}
	_, werr := fh.Write(line)
	cerr := fh.Close()
	if werr != nil {
		return werr
	}
	return cerr
}

// Read returns the events with a sequence number greater than afterSeq.
func (f *ResultFiles) Read(id string, afterSeq int) []RunEvent {
	p, err := f.path(id)
	if err != nil {
		return nil
	}
	f.mu.Lock()
	b, err := os.ReadFile(p)
	f.mu.Unlock()
	if err != nil {
		return nil
	}
	var out []RunEvent
	for _, line := range bytes.Split(b, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var ev RunEvent
		if json.Unmarshal(line, &ev) != nil {
			continue // a torn last line after a crash carries nothing usable
		}
		if ev.Seq > afterSeq {
			out = append(out, ev)
		}
	}
	return out
}

func (f *ResultFiles) LastSeq(id string) int {
	evs := f.Read(id, 0)
	if len(evs) == 0 {
		return 0
	}
	return evs[len(evs)-1].Seq
}

func (f *ResultFiles) Delete(id string) {
	if p, err := f.path(id); err == nil {
		_ = os.Remove(p)
	}
}
