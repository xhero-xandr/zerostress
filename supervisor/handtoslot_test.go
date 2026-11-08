package main

import (
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
)

// The run directory and the disk go to the slot's group with group access, nothing for others; an invalid slot or a
// host without the slot's group is refused, and zsvm would refuse such a directory anyway.
func TestHandToSlot(t *testing.T) {
	if err := handToSlot(t.TempDir(), 7); err == nil {
		t.Fatal("slot 7 was accepted")
	}
	dir := t.TempDir()
	disk := filepath.Join(dir, "rootfs.ext4")
	if err := os.WriteFile(disk, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	g, lookErr := user.LookupGroup(slotGroup(2))
	err := handToSlot(dir, 2)
	if lookErr != nil {
		if err == nil {
			t.Fatal("handed over without the slot's group on this host")
		}
		t.Skipf("no %s on this host (it is made by deploy/steps/10-host.sh): only the refusal is checked", slotGroup(2))
	}
	if err != nil {
		t.Fatalf("hand over as a member of %s: %v", g.Name, err)
	}
	gid, _ := strconv.Atoi(g.Gid)
	for path, mode := range map[string]os.FileMode{dir: 0o770, disk: 0o660} {
		st, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != mode {
			t.Errorf("%s: mode %o, want %o", filepath.Base(path), st.Mode().Perm(), mode)
		}
		if got := int(st.Sys().(*syscall.Stat_t).Gid); got != gid {
			t.Errorf("%s: group %d, want %d (%s)", filepath.Base(path), got, gid, g.Name)
		}
	}
}
