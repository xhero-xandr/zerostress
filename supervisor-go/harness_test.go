package main

import (
	"reflect"
	"testing"
)

// The first test exercises the whole path through the fake host: it is also the check that the harness itself works.
func TestSuccessfulRunStatesEvidenceAndCleanup(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"e":1}`, `{"e":2}`, okStatus}}}, nil)
	h.start(t)
	id := h.submit(t, "/ok")
	v := h.finished(t, id)
	if v.State != StateDone || v.AgentStatus == nil || *v.AgentStatus != "ok" || v.Partial {
		t.Fatalf("view = %+v", v)
	}
	want := []string{"queued", "preparing", "booting", "running", "destroying", "done"}
	if got := dedupe(h.states(id)); !reflect.DeepEqual(got, want) {
		t.Fatalf("states = %v, want %v", got, want)
	}
	if got := h.evidence(id); !reflect.DeepEqual(got, []string{`{"e":1}`, `{"e":2}`}) {
		t.Fatalf("evidence = %v", got)
	}
	for i, e := range h.events(id) {
		if e.Seq != i+1 {
			t.Fatalf("event %d has seq %d", i, e.Seq)
		}
	}
	h.idle(t)
}
