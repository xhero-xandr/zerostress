package main

import (
	"encoding/json"
	"strings"
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

// The image is shared and read-only; the run writes only to its own scratch disk, and the guest boots through
// zerostress-init, which lays the scratch disk over the image (review D3).
func TestVMConfigMountsTheImageReadOnlyAndTheScratchDiskOfTheRun(t *testing.T) {
	steps := vmConfig(Config{KernelPath: "/k", ImagePath: "/img/guest-rootfs.ext4"}, StartOptions{Slot: 1, RunID: "r", RunDir: "/d", VCPU: 2, MemMiB: 1024}, "/d/v.sock")
	drives := map[string]map[string]any{}
	var boot map[string]any
	for _, st := range steps {
		var v map[string]any
		if err := json.Unmarshal([]byte(st.body), &v); err != nil {
			t.Fatalf("%s: %v", st.path, err)
		}
		if id, ok := v["drive_id"].(string); ok {
			drives[id] = v
		}
		if st.path == "/boot-source" {
			boot = v
		}
	}
	if len(drives) != 2 {
		t.Fatalf("drives: %v", drives)
	}
	if r := drives["rootfs"]; r["path_on_host"] != "/img/guest-rootfs.ext4" || r["is_read_only"] != true || r["is_root_device"] != true {
		t.Errorf("rootfs: %v", r)
	}
	if s := drives["scratch"]; s["path_on_host"] != "/d/scratch.ext4" || s["is_read_only"] != false || s["is_root_device"] != false {
		t.Errorf("scratch: %v", s)
	}
	args, _ := boot["boot_args"].(string)
	for _, want := range []string{" root=/dev/vda ro ", " init=/usr/local/sbin/zerostress-init "} {
		if !strings.Contains(" "+args+" ", want) {
			t.Errorf("boot args %q lack %q", args, want)
		}
	}
	if strings.Contains(" "+args+" ", " rw ") {
		t.Errorf("boot args %q mount the image read-write", args)
	}
}
