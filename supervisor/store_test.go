package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func storeTID(n int) string { return fmt.Sprintf("%08x-0000-4000-8000-%012x", n, n) }

func storeTOpen(t *testing.T, dir string) *Store {
	t.Helper()
	s, problems := NewStore(dir)
	if len(problems) > 0 {
		t.Fatalf("problems: %v", problems)
	}
	return s
}

func storeTInsert(t *testing.T, s *Store, n int, createdAt, expiresAt int64) string {
	t.Helper()
	id := storeTID(n)
	if err := s.Insert(RunRecord{ID: id, URL: fmt.Sprintf("https://example.test/%d", n), CreatedAt: createdAt, ExpiresAt: expiresAt}); err != nil {
		t.Fatal(err)
	}
	return id
}

func storeTIDs(recs []RunRecord) []string {
	out := []string{}
	for _, r := range recs {
		out = append(out, r.ID)
	}
	return out
}

func TestStore_PersistsEveryFieldAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s := storeTOpen(t, dir)
	lim := SessionLimits{IdleMs: 7000, MaxMs: 9000}
	id := storeTID(1)
	if err := s.Insert(RunRecord{ID: id, URL: "https://example.test/a?x=1&y=<2>", CreatedAt: 1000, ExpiresAt: 99000, Session: &lim}); err != nil {
		t.Fatal(err)
	}
	plain := storeTID(2)
	if err := s.Insert(RunRecord{ID: plain, URL: "https://example.test/plain", CreatedAt: 1001, ExpiresAt: 99001}); err != nil {
		t.Fatal(err)
	}
	if err := s.Update(id, func(r *RunRecord) {
		r.State = StateFailed
		r.Reason = ReasonTimeout
		r.Slot = ptr(3)
		r.StartedAt = ptr(int64(1100))
		r.FinishedAt = ptr(int64(1900))
		r.AgentStatus = "timeout"
		r.Partial = true
		r.Events = 17
	}); err != nil {
		t.Fatal(err)
	}
	want, _ := s.Get(id)
	wantPlain, _ := s.Get(plain)

	s2 := storeTOpen(t, dir)
	got, ok := s2.Get(id)
	if !ok {
		t.Fatal("record lost")
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after reopen:\n got %+v\nwant %+v", got, want)
	}
	if got.State != StateFailed || got.Reason != ReasonTimeout || *got.Slot != 3 || *got.StartedAt != 1100 || *got.FinishedAt != 1900 ||
		got.AgentStatus != "timeout" || !got.Partial || got.Events != 17 || got.CreatedAt != 1000 || got.ExpiresAt != 99000 ||
		got.URL != "https://example.test/a?x=1&y=<2>" || got.Session == nil || *got.Session != lim {
		t.Fatalf("fields = %+v", got)
	}
	gotPlain, _ := s2.Get(plain)
	if !reflect.DeepEqual(gotPlain, wantPlain) || gotPlain.Session != nil || gotPlain.Slot != nil || gotPlain.StartedAt != nil || gotPlain.State != StateQueued {
		t.Fatalf("plain record = %+v", gotPlain)
	}
}

func TestStore_GetReturnsACopy(t *testing.T) {
	s := storeTOpen(t, t.TempDir())
	lim := SessionLimits{IdleMs: 1, MaxMs: 2}
	id := storeTID(1)
	if err := s.Insert(RunRecord{ID: id, URL: "u", CreatedAt: 1, ExpiresAt: 2, Session: &lim}); err != nil {
		t.Fatal(err)
	}
	if err := s.Update(id, func(r *RunRecord) { r.Slot = ptr(1) }); err != nil {
		t.Fatal(err)
	}
	a, _ := s.Get(id)
	a.State = StateDone
	a.Session.IdleMs = 99
	*a.Slot = 9
	b, _ := s.Get(id)
	if b.State != StateQueued || b.Session.IdleMs != 1 || *b.Slot != 1 {
		t.Fatalf("stored record changed through a copy: %+v", b)
	}
}

func TestStore_QueuedOrderedByCreatedAtThenInsertionAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s := storeTOpen(t, dir)
	a := storeTInsert(t, s, 1, 100, 1000)
	b := storeTInsert(t, s, 2, 50, 1000)
	c := storeTInsert(t, s, 3, 100, 1000) // same millisecond as a: insertion order decides
	d := storeTInsert(t, s, 4, 100, 1000)
	e := storeTInsert(t, s, 5, 70, 1000)
	if err := s.Update(e, func(r *RunRecord) { r.State = StateRunning }); err != nil {
		t.Fatal(err)
	}
	want := []string{b, a, c, d}
	if got := storeTIDs(s.Queued()); !reflect.DeepEqual(got, want) {
		t.Fatalf("queued = %v, want %v", got, want)
	}
	s2 := storeTOpen(t, dir)
	if got := storeTIDs(s2.Queued()); !reflect.DeepEqual(got, want) {
		t.Fatalf("after reopen queued = %v, want %v", got, want)
	}
	// an insert after the reopen must sort after the earlier ones of the same millisecond
	f := storeTInsert(t, s2, 6, 100, 1000)
	if got := storeTIDs(s2.Queued()); !reflect.DeepEqual(got, append(append([]string{}, want...), f)) {
		t.Fatalf("after reopen and insert queued = %v", got)
	}
}

func TestStore_InFlightIncludesSessionState(t *testing.T) {
	s := storeTOpen(t, t.TempDir())
	states := []RunState{StateQueued, StatePreparing, StateBooting, StateRunning, StateSession, StateDestroying, StateDone, StateFailed}
	inflight := map[string]bool{}
	for i, st := range states {
		id := storeTInsert(t, s, i+1, int64(100+i), 1000)
		st := st
		if err := s.Update(id, func(r *RunRecord) { r.State = st }); err != nil {
			t.Fatal(err)
		}
		switch st {
		case StatePreparing, StateBooting, StateRunning, StateSession, StateDestroying:
			inflight[id] = true
		}
	}
	got := s.InFlight()
	if len(got) != 5 {
		t.Fatalf("in flight = %v", storeTIDs(got))
	}
	for _, r := range got {
		if !inflight[r.ID] {
			t.Fatalf("%s (%s) is not in flight", r.ID, r.State)
		}
	}
	if len(s.Queued()) != 1 {
		t.Fatalf("queued = %v", storeTIDs(s.Queued()))
	}
}

func TestStore_ExpiredReturnsOnlyFinishedRunsPastRetention(t *testing.T) {
	s := storeTOpen(t, t.TempDir())
	const now = 5000
	finish := func(n int, expires int64, st RunState) string {
		id := storeTInsert(t, s, n, 100, expires)
		if err := s.Update(id, func(r *RunRecord) { r.State = st }); err != nil {
			t.Fatal(err)
		}
		return id
	}
	doneOld := finish(1, now-1, StateDone)
	failedOld := finish(2, now-100, StateFailed)
	boundary := finish(3, now, StateDone) // expires_at <= now
	finish(4, now+1, StateDone)
	finish(5, now-1, StateRunning) // expired timestamp but still alive: never removed
	finish(6, now-1, StateQueued)
	got := map[string]bool{}
	for _, id := range s.Expired(now) {
		got[id] = true
	}
	want := map[string]bool{doneOld: true, failedOld: true, boundary: true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expired = %v, want %v", got, want)
	}
}

func TestStore_DeleteRemovesRecordAndFile(t *testing.T) {
	dir := t.TempDir()
	s := storeTOpen(t, dir)
	a := storeTInsert(t, s, 1, 100, 1000)
	b := storeTInsert(t, s, 2, 101, 1000)
	file := filepath.Join(dir, a+".json")
	if _, err := os.Stat(file); err != nil {
		t.Fatal(err)
	}
	s.Delete(a)
	s.Delete(a) // deleting twice, or something unknown, is harmless
	s.Delete(storeTID(99))
	if _, ok := s.Get(a); ok {
		t.Fatal("record still in memory")
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("file still there: %v", err)
	}
	s2 := storeTOpen(t, dir)
	if _, ok := s2.Get(a); ok {
		t.Fatal("deleted record came back")
	}
	if _, ok := s2.Get(b); !ok {
		t.Fatal("the other record was lost")
	}
}

func TestStore_DamagedFileAndStrayTmpDoNotFailStartup(t *testing.T) {
	dir := t.TempDir()
	s := storeTOpen(t, dir)
	good := storeTInsert(t, s, 1, 100, 1000)

	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	damaged := storeTID(2) + ".json"
	write(damaged, `{"id": "`+storeTID(2)+`", "url": "trunc`)
	write("not-an-id.json", `{"id":"not-an-id","url":"u","state":"queued"}`)
	// a record that claims another id than its file name must not be trusted
	write(storeTID(3)+".json", `{"id":"`+storeTID(4)+`","url":"u","state":"queued"}`)
	stray := storeTID(5) + ".json.tmp"
	write(stray, `{"id":"`+storeTID(5)+`"`)
	write("README.txt", "not a record")

	s2, problems := NewStore(dir)
	if len(problems) != 3 {
		t.Fatalf("problems = %v, want 3", problems)
	}
	if _, ok := s2.Get(good); !ok {
		t.Fatal("the good record was lost")
	}
	for _, id := range []string{storeTID(2), "not-an-id", storeTID(3), storeTID(4)} {
		if _, ok := s2.Get(id); ok {
			t.Fatalf("%s was loaded", id)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, stray)); !os.IsNotExist(err) {
		t.Fatalf("the stray .tmp file was not removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "README.txt")); err != nil {
		t.Fatal("an unrelated file was touched")
	}
	if _, err := os.Stat(filepath.Join(dir, damaged)); err != nil {
		t.Fatal("the damaged file must be left for inspection")
	}
	// the store still works
	if got := storeTIDs(s2.Queued()); !reflect.DeepEqual(got, []string{good}) {
		t.Fatalf("queued = %v", got)
	}
	storeTInsert(t, s2, 6, 200, 1000)
}

func TestStore_InvalidRunIDsAreRejected(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "records")
	s := storeTOpen(t, dir)
	bad := []string{"../x", "..", "", "x/../y", "a/b", storeTID(1) + "/..", strings.ToUpper(storeTID(0xabc)), "11111111-1111-4111-8111-11111111111", storeTID(1) + ".json"}
	for _, id := range bad {
		if err := s.Insert(RunRecord{ID: id, URL: "u", CreatedAt: 1, ExpiresAt: 2}); err == nil {
			t.Errorf("Insert(%q) succeeded", id)
		}
		if _, ok := s.Get(id); ok {
			t.Errorf("Get(%q) found something", id)
		}
		if err := s.Update(id, func(r *RunRecord) { r.State = StateDone }); err == nil {
			t.Errorf("Update(%q) succeeded", id)
		}
	}
	for _, e := range []string{filepath.Join(root, "x.json"), filepath.Join(root, "x.json.tmp")} {
		if _, err := os.Stat(e); err == nil {
			t.Errorf("%s was created outside the store directory", e)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("files written for invalid ids: %v", entries)
	}
}

// Delete takes an id from the caller like every other method, so it must not be possible to delete a file outside the
// directory with one.
func TestStore_DeleteWithPathTraversalIDTouchesNothingOutside(t *testing.T) {
	root := t.TempDir()
	s := storeTOpen(t, filepath.Join(root, "records"))
	victim := filepath.Join(root, "x.json")
	if err := os.WriteFile(victim, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.Delete("../x")
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("Delete(\"../x\") removed a file outside the store directory: %v", err)
	}
}

func TestStore_ConcurrentUseKeepsRecordsIntact(t *testing.T) {
	dir := t.TempDir()
	s := storeTOpen(t, dir)
	const n = 40
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := storeTID(i + 1)
			if err := s.Insert(RunRecord{ID: id, URL: "u", CreatedAt: int64(i % 5), ExpiresAt: 1000}); err != nil {
				t.Error(err)
				return
			}
			for k := 0; k < 5; k++ {
				if err := s.Update(id, func(r *RunRecord) { r.Events++ }); err != nil {
					t.Error(err)
				}
				s.Queued()
				s.Get(id)
			}
		}(i)
	}
	wg.Wait()
	s2 := storeTOpen(t, dir)
	if got := len(s2.Queued()); got != n {
		t.Fatalf("%d records after reopen, want %d", got, n)
	}
	for i := 0; i < n; i++ {
		if r, _ := s2.Get(storeTID(i + 1)); r.Events != 5 {
			t.Fatalf("record %d has %d events", i, r.Events)
		}
	}
	seqs := map[int64]bool{}
	for _, r := range s2.Queued() {
		if seqs[r.Seq] {
			t.Fatalf("sequence number %d used twice", r.Seq)
		}
		seqs[r.Seq] = true
	}
}

func TestStore_ResultFilesAppendReadAfterSeqAndLastSeq(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "results")
	f, err := NewResultFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := storeTID(1)
	if got := f.Read(id, 0); len(got) != 0 {
		t.Fatalf("read of a missing log = %v", got)
	}
	if f.LastSeq(id) != 0 {
		t.Fatal("last seq of a missing log is not 0")
	}
	data := []string{`{"state":"queued"}`, "line with \"quotes\"", "two\nlines and <tags> &   unicode ✓", `{"a":1}`, ""}
	for i, d := range data {
		if err := f.Append(id, RunEvent{Seq: i + 1, Type: "evidence", Data: d}); err != nil {
			t.Fatal(err)
		}
	}
	all := f.Read(id, 0)
	if len(all) != len(data) {
		t.Fatalf("read %d events, want %d", len(all), len(data))
	}
	for i, e := range all {
		if e.Seq != i+1 || e.Type != "evidence" || e.Data != data[i] {
			t.Fatalf("event %d = %+v", i, e)
		}
	}
	if got := f.Read(id, 3); len(got) != 2 || got[0].Seq != 4 || got[1].Seq != 5 {
		t.Fatalf("read after 3 = %+v", got)
	}
	if got := f.Read(id, 5); len(got) != 0 {
		t.Fatalf("read after the last = %+v", got)
	}
	if got := f.LastSeq(id); got != 5 {
		t.Fatalf("last seq = %d", got)
	}
	other := storeTID(2)
	if len(f.Read(other, 0)) != 0 {
		t.Fatal("events of another run")
	}
	f.Delete(id)
	if len(f.Read(id, 0)) != 0 || f.LastSeq(id) != 0 {
		t.Fatal("log survived Delete")
	}
	f.Delete(id) // harmless the second time
}

func TestStore_ResultFilesTornLastLineIsIgnored(t *testing.T) {
	dir := t.TempDir()
	f, err := NewResultFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := storeTID(1)
	for i := 1; i <= 3; i++ {
		if err := f.Append(id, RunEvent{Seq: i, Type: "state", Data: "{}"}); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dir, id+".ndjson")
	fh, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.WriteString(`{"seq":4,"type":"evi`); err != nil { // the process died in the middle of a write
		t.Fatal(err)
	}
	fh.Close()
	if got := f.Read(id, 0); len(got) != 3 {
		t.Fatalf("read %d events, want the 3 intact ones", len(got))
	}
	if got := f.LastSeq(id); got != 3 {
		t.Fatalf("last seq = %d", got)
	}
	if got := f.Read(id, 2); len(got) != 1 || got[0].Seq != 3 {
		t.Fatalf("read after 2 = %+v", got)
	}
}

// After a crash the supervisor continues the log with LastSeq+1. The event written then must not be glued onto the torn
// fragment and lost with it.
func TestStore_ResultFilesAppendAfterTornLineIsNotLost(t *testing.T) {
	dir := t.TempDir()
	f, err := NewResultFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := storeTID(1)
	for i := 1; i <= 2; i++ {
		if err := f.Append(id, RunEvent{Seq: i, Type: "state", Data: "{}"}); err != nil {
			t.Fatal(err)
		}
	}
	fh, err := os.OpenFile(filepath.Join(dir, id+".ndjson"), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.WriteString(`{"seq":3,"type":"evi`); err != nil {
		t.Fatal(err)
	}
	fh.Close()
	if err := f.Append(id, RunEvent{Seq: 3, Type: "state", Data: `{"state":"failed"}`}); err != nil {
		t.Fatal(err)
	}
	got := f.Read(id, 0)
	if len(got) != 3 || got[2].Seq != 3 || got[2].Data != `{"state":"failed"}` {
		t.Fatalf("events after the torn line = %+v (the new event was lost)", got)
	}
}

func TestStore_ResultFilesInvalidIDsAreRejected(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "results")
	f, err := NewResultFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"../../etc/passwd", "x/../y", "", "..", "../x", strings.ToUpper(storeTID(0xabc)), storeTID(1) + "/../../x"} {
		if err := f.Append(id, RunEvent{Seq: 1, Type: "state", Data: "{}"}); err == nil {
			t.Errorf("Append(%q) succeeded", id)
		}
		if got := f.Read(id, 0); got != nil {
			t.Errorf("Read(%q) = %v", id, got)
		}
		if f.LastSeq(id) != 0 {
			t.Errorf("LastSeq(%q) != 0", id)
		}
	}
	// Delete of an invalid id must be a no-op, in particular for a path that leads out of the directory
	victim := filepath.Join(root, "x.ndjson")
	if err := os.WriteFile(victim, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.Delete("../x")
	if _, err := os.Stat(victim); err != nil {
		t.Errorf("Delete(\"../x\") removed a file outside the directory: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("files written for invalid ids: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(root, "etc")); err == nil {
		t.Error("a directory was created outside")
	}
}

func TestStore_ResultFilesConcurrentAppendKeepsEveryLineIntact(t *testing.T) {
	dir := t.TempDir()
	f, err := NewResultFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := storeTID(1)
	const writers, each = 24, 40
	payload := func(g, i int) string { return fmt.Sprintf("g%d-i%d-%s", g, i, strings.Repeat("p", 3000+g*50)) }
	var wg sync.WaitGroup
	for g := 0; g < writers; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				if err := f.Append(id, RunEvent{Seq: g*1000 + i + 1, Type: "evidence", Data: payload(g, i)}); err != nil {
					t.Error(err)
					return
				}
				if i%10 == 0 {
					f.Read(id, 0) // readers run in between
				}
			}
		}(g)
	}
	wg.Wait()
	got := f.Read(id, 0)
	if len(got) != writers*each {
		t.Fatalf("%d events, want %d", len(got), writers*each)
	}
	seen := map[int]bool{}
	for _, e := range got {
		g, i := (e.Seq-1)/1000, (e.Seq-1)%1000
		if e.Type != "evidence" || e.Data != payload(g, i) {
			t.Fatalf("event %d damaged", e.Seq)
		}
		if seen[e.Seq] {
			t.Fatalf("event %d twice", e.Seq)
		}
		seen[e.Seq] = true
	}
	// each writer's own events are in the order it wrote them
	last := map[int]int{}
	for _, e := range got {
		g := (e.Seq - 1) / 1000
		if e.Seq <= last[g] {
			t.Fatalf("writer %d: event %d after %d", g, e.Seq, last[g])
		}
		last[g] = e.Seq
	}
}

// A change that could not be written stays out of memory too: what Get says is what a restart would find (review E).
func TestStore_AFailedWriteLeavesTheRecordAsItWas(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a read-only directory")
	}
	dir := t.TempDir()
	s := storeTOpen(t, dir)
	id := storeTID(1)
	if err := s.Insert(RunRecord{ID: id, URL: "u", CreatedAt: 1, ExpiresAt: 2}); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o700)
	if err := s.Update(id, func(r *RunRecord) { r.State = StateRunning; r.Slot = ptr(2) }); err == nil {
		t.Fatal("the write into a read-only directory did not fail")
	}
	got, _ := s.Get(id)
	if got.State != StateQueued || got.Slot != nil {
		t.Fatalf("memory took a change the disk did not: %+v", got)
	}
}

// A record holds the address a visitor sent, so what is on disk is private to the service, and a record is replaced
// whole by a rename (a reader or a crash never sees half a file), not rewritten in place.
func TestStore_RecordsStayPrivateAndAreReplacedByRename(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "records") // the store makes it, so its own mode shows
	s := storeTOpen(t, dir)
	if st, err := os.Stat(dir); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("the records directory: %v, %v (want 0700)", st, err)
	}
	id := storeTInsert(t, s, 1, 1000, 99000)
	path := filepath.Join(dir, id+".json")
	first, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if first.Mode().Perm() != 0o600 {
		t.Fatalf("a record's mode is %v (want 0600)", first.Mode().Perm())
	}
	if err := s.Update(id, func(r *RunRecord) { r.State = StateFailed }); err != nil {
		t.Fatal(err)
	}
	second, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(first, second) {
		t.Fatal("the record was rewritten in place: it must be written under another name and renamed over the old one")
	}
	if second.Mode().Perm() != 0o600 {
		t.Fatalf("the replaced record's mode is %v (want 0600)", second.Mode().Perm())
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("a temporary file was left behind: %s", e.Name())
		}
	}
}
