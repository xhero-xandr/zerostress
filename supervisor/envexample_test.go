package main

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// Every SUP_* variable the supervisor reads is in the example the host's supervisor.env is made from, the example names
// nothing else, and docs/config.md describes each one (spec 010, 4.3).
func TestEnvExampleMatchesConfig(t *testing.T) {
	src, err := os.ReadFile("config.go")
	if err != nil {
		t.Fatal(err)
	}
	example, err := os.ReadFile("../config/supervisor.env.example")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := os.ReadFile("../docs/config.md")
	if err != nil {
		t.Fatal(err)
	}
	var read, named []string
	for _, m := range regexp.MustCompile(`(?:get|envStr)\((?:env, )?"(SUP_[A-Z0-9_]+)"`).FindAllStringSubmatch(string(src), -1) {
		read = append(read, m[1])
	}
	for _, m := range regexp.MustCompile(`(?m)^#? ?(SUP_[A-Z0-9_]+)=`).FindAllStringSubmatch(string(example), -1) {
		named = append(named, m[1])
	}
	if len(read) < 10 {
		t.Fatalf("the scan found only %d variables in config.go: it no longer matches the code", len(read))
	}
	for _, v := range read {
		if !slices.Contains(named, v) {
			t.Errorf("%s is read by config.go but missing from supervisor.env.example", v)
		}
		if !strings.Contains(string(doc), "`"+v+"`") {
			t.Errorf("%s is not described in docs/config.md", v)
		}
	}
	for _, v := range named {
		if !slices.Contains(read, v) {
			t.Errorf("%s is in supervisor.env.example but config.go does not read it", v)
		}
	}
}
