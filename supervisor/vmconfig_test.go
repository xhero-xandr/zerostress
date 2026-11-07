package main

import (
	"encoding/json"
	"testing"
)

func TestVMConfigIsValidJSONAndCapsWhatTheGuestSends(t *testing.T) {
	steps := vmConfig(Config{KernelPath: "/k"}, StartOptions{Slot: 2, RunID: "r", RunDir: "/d", VCPU: 2, MemMiB: 1024}, "/d/v.sock")
	if steps[len(steps)-1].path != "/actions" {
		t.Fatalf("the VM must be started last: %+v", steps[len(steps)-1])
	}
	var net map[string]any
	for _, st := range steps {
		var v map[string]any
		if err := json.Unmarshal([]byte(st.body), &v); err != nil {
			t.Fatalf("%s: %v", st.path, err)
		}
		if st.path == "/network-interfaces/net1" {
			net = v
		}
	}
	if net == nil || net["host_dev_name"] != "zstap2" {
		t.Fatalf("network interface: %v", net)
	}
	tx, _ := net["tx_rate_limiter"].(map[string]any)
	bw, _ := tx["bandwidth"].(map[string]any)
	ops, _ := tx["ops"].(map[string]any)
	if bw["size"] != float64(2<<20) || bw["refill_time"] != float64(1000) || ops["size"] != float64(3000) || ops["refill_time"] != float64(1000) {
		t.Fatalf("the guest's outgoing traffic is not capped as meant: %v", tx)
	}
}
