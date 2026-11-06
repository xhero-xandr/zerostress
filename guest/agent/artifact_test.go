package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const goodName = "0123456789abcdef.png"

func artifactConfig(t *testing.T) (Config, string) {
	t.Helper()
	dir := t.TempDir()
	cfg := testConfig("cat")
	cfg.ArtifactDir = dir
	cfg.MaxArtifact = 1 << 20
	return cfg, dir
}

// fetch sends a hand-over request and returns the header and the bytes that followed it.
func fetch(t *testing.T, dial func() net.Conn, req string) (artifactReply, []byte) {
	t.Helper()
	c := dial()
	defer c.Close()
	if _, err := c.Write([]byte(req + "\n")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(c)
	line, err := br.ReadBytes('\n')
	if err != nil {
		t.Fatalf("no header: %v", err)
	}
	var h artifactReply
	if err := json.Unmarshal(line, &h); err != nil || h.Type != "artifact" {
		t.Fatalf("bad header %q", line)
	}
	rest, _ := io.ReadAll(br)
	return h, rest
}

func request(name string) string {
	b, _ := json.Marshal(map[string]string{"op": "artifact", "name": name})
	return string(b)
}

func TestArtifactIsServedByteForByte(t *testing.T) {
	cfg, dir := artifactConfig(t)
	want := append([]byte{0x89, 'P', 'N', 'G'}, bytes.Repeat([]byte{0, 1, 2, '\n', 255}, 5000)...)
	if err := os.WriteFile(filepath.Join(dir, goodName), want, 0o600); err != nil {
		t.Fatal(err)
	}
	_, dial := serve(t, cfg)
	h, got := fetch(t, dial, request(goodName))
	if !h.OK || h.Bytes != int64(len(want)) {
		t.Fatalf("header: %+v", h)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %d bytes, want %d", len(got), len(want))
	}
}

func TestArtifactIsServedWhileASessionRuns(t *testing.T) {
	cfg, dir := artifactConfig(t)
	if err := os.WriteFile(filepath.Join(dir, "aaaaaaaaaaaaaaaa.bin"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, dial := serve(t, cfg)
	job := dial()
	defer job.Close()
	if _, err := job.Write([]byte(`{"schema":1,"session":{"max_s":30}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // the session job is running and holds the job slot
	h, got := fetch(t, dial, request("aaaaaaaaaaaaaaaa.bin"))
	if !h.OK || string(got) != "data" {
		t.Fatalf("hand-over during a session: %+v %q", h, got)
	}
	// the job slot is still taken: a second job is refused, which shows the hand-over did not take or free it
	second := dial()
	defer second.Close()
	_, _ = second.Write([]byte(`{"schema":1}` + "\n"))
	if lines := readLines(t, second); !strings.Contains(strings.Join(lines, ""), `"busy"`) {
		t.Fatalf("second job: %v", lines)
	}
}

func TestArtifactRefusals(t *testing.T) {
	cfg, dir := artifactConfig(t)
	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("root only"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(dir, "1111111111111111.bin")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "2222222222222222.png"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "3333333333333333.bin"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "4444444444444444.bin"), bytes.Repeat([]byte{1}, 2<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	_, dial := serve(t, cfg)
	cases := []struct{ name, code string }{
		{"../etc/passwd", "bad_name"},
		{"../" + goodName, "bad_name"},
		{"0123456789ABCDEF.png", "bad_name"},
		{"0123456789abcdef.exe", "bad_name"},
		{"0123456789abcdef.png/", "bad_name"},
		{"0123456789abcde.png", "bad_name"},
		{"", "bad_name"},
		{"9999999999999999.png", "not_found"},
		{"1111111111111111.bin", "not_found"},   // a symbolic link is never followed
		{"2222222222222222.png", "not_regular"}, // a directory
		{"3333333333333333.bin", "not_regular"}, // a FIFO must not block the agent
		{"4444444444444444.bin", "too_large"},
	}
	for _, c := range cases {
		h, rest := fetch(t, dial, request(c.name))
		if h.OK || h.Error != c.code || len(rest) != 0 {
			t.Errorf("%q: got %+v (+%d bytes), want %s", c.name, h, len(rest), c.code)
		}
	}
}

func TestArtifactOfAnotherOwnerIsRefused(t *testing.T) {
	cfg, dir := artifactConfig(t)
	if err := os.WriteFile(filepath.Join(dir, goodName), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ag, dial := serve(t, cfg)
	ag.cred = &syscall.Credential{Uid: uint32(os.Getuid()) + 1} // the collector user is somebody else
	if h, _ := fetch(t, dial, request(goodName)); h.OK || h.Error != "not_owned" {
		t.Fatalf("got %+v", h)
	}
	ag.cred = &syscall.Credential{Uid: uint32(os.Getuid())}
	if h, _ := fetch(t, dial, request(goodName)); !h.OK {
		t.Fatalf("own file refused: %+v", h)
	}
}

func TestUnknownOperationIsABadJob(t *testing.T) {
	cfg, _ := artifactConfig(t)
	_, dial := serve(t, cfg)
	c := dial()
	defer c.Close()
	_, _ = c.Write([]byte(`{"op":"shell","name":"x"}` + "\n"))
	if st := lastStatus(t, readLines(t, c)); st.Status != "bad_job" {
		t.Fatalf("got %+v", st)
	}
}

func TestOnlyTwoHandOversAtOnce(t *testing.T) {
	cfg, dir := artifactConfig(t)
	if err := os.WriteFile(filepath.Join(dir, goodName), bytes.Repeat([]byte{7}, 900<<10), 0o600); err != nil {
		t.Fatal(err)
	}
	_, dial := serve(t, cfg)
	// two readers that do not read: the agent blocks writing to them (up to its write deadline)
	var held []net.Conn
	for i := 0; i < 2; i++ {
		c := dial()
		held = append(held, c)
		_, _ = c.Write([]byte(request(goodName) + "\n"))
	}
	defer func() {
		for _, c := range held {
			c.Close()
		}
	}()
	time.Sleep(200 * time.Millisecond)
	if h, _ := fetch(t, dial, request(goodName)); h.OK || h.Error != "busy" {
		t.Fatalf("third hand-over: %+v", h)
	}
}
