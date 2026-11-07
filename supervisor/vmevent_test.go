package main

import (
	"encoding/json"
	"testing"
)

// The booting state tells which microVM runs the check, from the supervisor's own settings and image, so that the web
// layer's log shows what really happens; no other state carries it.
func TestBootingStateNamesTheMicroVM(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{okStatus}}}, func(c *Config) { c.VCPU = 3; c.MemMiB = 768 },
		func(d *Deps) { d.ImageSHA256 = func() string { return "7e016b2b2375b94e52f0ab270d3f3772" } })
	h.start(t)
	id, _ := coreTRun(t, h, "/ok")
	seen := 0
	for _, e := range h.events(id) {
		if e.Type != "state" {
			continue
		}
		var s struct {
			State string `json:"state"`
			VM    *struct {
				Slot   int    `json:"slot"`
				VCPU   int    `json:"vcpu"`
				MemMiB int    `json:"mem_mib"`
				Image  string `json:"image"`
			} `json:"vm"`
		}
		if err := json.Unmarshal([]byte(e.Data), &s); err != nil {
			t.Fatal(err)
		}
		if s.State != "booting" {
			if s.VM != nil {
				t.Fatalf("state %s carries the VM: %s", s.State, e.Data)
			}
			continue
		}
		seen++
		if s.VM == nil || s.VM.VCPU != 3 || s.VM.MemMiB != 768 || s.VM.Image != "7e016b2b2375" || s.VM.Slot < 0 {
			t.Fatalf("booting event = %s", e.Data)
		}
	}
	if seen != 1 {
		t.Fatalf("booting events: %d", seen)
	}
}
