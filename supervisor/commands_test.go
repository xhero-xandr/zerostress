package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Numbers are float64 because that is what encoding/json decodes into any.

type cmdTMap = map[string]any

func cmdTOk(t *testing.T, raw any) ValidCommand {
	t.Helper()
	c, problem := ValidateCommand(raw)
	if problem != "" {
		t.Fatalf("rejected %v: %s", raw, problem)
	}
	return c
}

func cmdTBad(t *testing.T, raw any, part string) {
	t.Helper()
	_, problem := ValidateCommand(raw)
	if problem == "" {
		t.Fatalf("accepted: %.80v", raw)
	}
	if !regexp.MustCompile(part).MatchString(problem) {
		t.Fatalf("%.80v: error %q does not match %q", raw, problem, part)
	}
}

func cmdTSubmit(values any, extra ...cmdTMap) cmdTMap {
	m := cmdTMap{"cmd": "submit_form", "id": "a", "snap": 1.0, "form": "e1", "values": values}
	for _, e := range extra {
		for k, v := range e {
			m[k] = v
		}
	}
	return m
}

func cmdTRefs(n int, v string) cmdTMap {
	m := cmdTMap{}
	for i := 0; i < n; i++ {
		m[fmt.Sprintf("e%d", i)] = v
	}
	return m
}

func TestCommands_EveryTypeAcceptedRiskFollowsType(t *testing.T) {
	cases := []struct {
		raw  cmdTMap
		risk Risk
	}{
		{cmdTMap{"cmd": "snapshot", "id": "a"}, RiskSafe},
		{cmdTMap{"cmd": "scroll", "id": "a", "dy": -5000.0}, RiskSafe},
		{cmdTMap{"cmd": "scroll", "id": "a", "dy": 5000.0}, RiskSafe},
		{cmdTMap{"cmd": "wait", "id": "a", "ms": 0.0}, RiskSafe},
		{cmdTMap{"cmd": "wait", "id": "a", "ms": 5000.0}, RiskSafe},
		{cmdTMap{"cmd": "screenshot", "id": "a"}, RiskSafe},
		{cmdTMap{"cmd": "screenshot", "id": "a", "full": true}, RiskSafe},
		{cmdTMap{"cmd": "open_link", "id": "a", "snap": 3.0, "ref": "e7"}, RiskSafe},
		{cmdTMap{"cmd": "open_link", "id": "a", "snap": 3.0, "ref": "f1e3"}, RiskSafe},
		{cmdTMap{"cmd": "back", "id": "a"}, RiskSafe},
		{cmdTMap{"cmd": "close", "id": "a"}, RiskSafe},
		{cmdTMap{"cmd": "download", "id": "a", "snap": 1.0, "ref": "e2"}, RiskRisky},
		{cmdTMap{"cmd": "submit_form", "id": "a", "snap": 1.0, "form": "e4", "values": cmdTMap{"e5": "x", "e6": "y"}}, RiskRisky},
		{cmdTMap{"cmd": "submit_form", "id": "a", "snap": 1.0, "form": "e4", "values": cmdTMap{}}, RiskRisky},
	}
	seen := map[string]bool{}
	for _, c := range cases {
		if got := cmdTOk(t, c.raw).Risk; got != c.risk {
			t.Fatalf("%v: risk = %s, want %s", c.raw, got, c.risk)
		}
		seen[c.raw["cmd"].(string)] = true
	}
	// the table and the cases above cover the same set
	var got []string
	for n := range seen {
		got = append(got, n)
	}
	sort.Strings(got)
	if want := CommandNames(); !reflect.DeepEqual(got, want) {
		t.Fatalf("cases cover %v, table has %v", got, want)
	}
}

func TestCommands_OnlyDownloadAndSubmitFormAreRisky(t *testing.T) {
	var risky []string
	for _, n := range CommandNames() {
		if commandTable[n].risk == RiskRisky {
			risky = append(risky, n)
		}
	}
	if want := []string{"download", "submit_form"}; !reflect.DeepEqual(risky, want) {
		t.Fatalf("risky = %v, want %v", risky, want)
	}
}

func TestCommands_UnknownTypesAndNonObjectsRejected(t *testing.T) {
	for _, cmd := range []string{"eval", "evaluate", "goto", "click", "constructor", "__proto__", "toString", "hasOwnProperty", "", "SNAPSHOT"} {
		cmdTBad(t, cmdTMap{"cmd": cmd, "id": "a"}, "unknown command type")
	}
	for _, raw := range []any{nil, 5.0, "snapshot", []any{}, []any{cmdTMap{"cmd": "snapshot", "id": "a"}}, true} {
		cmdTBad(t, raw, "JSON object")
	}
	cmdTBad(t, cmdTMap{"id": "a"}, "unknown command type")
	cmdTBad(t, cmdTMap{"cmd": 5.0, "id": "a"}, "unknown command type")
}

func TestCommands_IDMustMatchPattern(t *testing.T) {
	for _, id := range []any{"", "a b", "a/b", "a.b", "é", strings.Repeat("x", 65), 5.0, nil, "a\n"} {
		cmdTBad(t, cmdTMap{"cmd": "snapshot", "id": id}, "id must match")
	}
	cmdTBad(t, cmdTMap{"cmd": "snapshot"}, "id must match")
	cmdTOk(t, cmdTMap{"cmd": "snapshot", "id": "A-z_0-9"})
	cmdTOk(t, cmdTMap{"cmd": "snapshot", "id": strings.Repeat("x", 64)})
}

func TestCommands_UnknownMissingMisplacedFieldsRejected(t *testing.T) {
	cmdTBad(t, cmdTMap{"cmd": "snapshot", "id": "a", "extra": 1.0}, "unknown field: extra")
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a", "dy": 1.0, "ms": 2.0}, "unknown field: ms")
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a"}, "missing field: dy")
	cmdTBad(t, cmdTMap{"cmd": "open_link", "id": "a", "ref": "e1"}, "missing field: snap")
	cmdTBad(t, cmdTMap{"cmd": "open_link", "id": "a", "snap": 1.0}, "missing field: ref")
	cmdTBad(t, cmdTMap{"cmd": "submit_form", "id": "a", "snap": 1.0, "form": "e1"}, "missing field: values")
	cmdTBad(t, cmdTMap{"cmd": "download", "id": "a", "snap": 1.0, "ref": "e1", "url": "https://evil.test/"}, "unknown field: url")
	// a raw JSON "__proto__" key is an ordinary key after decoding and must not slip through
	var proto any
	if err := json.Unmarshal([]byte(`{"cmd":"snapshot","id":"a","__proto__":{"x":1}}`), &proto); err != nil {
		t.Fatal(err)
	}
	cmdTBad(t, proto, "unknown field: __proto__")
	// the name in the message is cut at 40 characters
	cmdTBad(t, cmdTMap{"cmd": "snapshot", "id": "a", strings.Repeat("k", 60): 1.0}, "^unknown field: k{40}$")
}

func TestCommands_NumericParametersAreIntegersInRange(t *testing.T) {
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a", "dy": 5001.0}, "dy must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a", "dy": -5001.0}, "dy must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a", "dy": 1.5}, "dy must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a", "dy": "10"}, "dy must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a", "dy": math.NaN()}, "dy must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "scroll", "id": "a", "dy": math.Inf(1)}, "dy must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "wait", "id": "a", "ms": -1.0}, "ms must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "wait", "id": "a", "ms": 5001.0}, "ms must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "open_link", "id": "a", "snap": -1.0, "ref": "e1"}, "snap must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "open_link", "id": "a", "snap": 1e12, "ref": "e1"}, "snap must be an integer")
	cmdTBad(t, cmdTMap{"cmd": "screenshot", "id": "a", "full": "yes"}, "full must be true or false")
	// the limits themselves are in range
	cmdTOk(t, cmdTMap{"cmd": "open_link", "id": "a", "snap": 1e9, "ref": "e1"})
}

func TestCommands_ElementReferencesHaveFixedShape(t *testing.T) {
	for _, r := range []any{"", "e", "7", "e-1", "E7", " e7", "e7 ", "e7;x", "a1", "f1", "e1e2", "f99999e1", "e1234567890", 5.0, nil, []any{"e1"}} {
		cmdTBad(t, cmdTMap{"cmd": "open_link", "id": "a", "snap": 1.0, "ref": r}, "ref must be an element reference")
	}
	cmdTBad(t, cmdTMap{"cmd": "submit_form", "id": "a", "snap": 1.0, "form": "form-1", "values": cmdTMap{}}, "form must be an element reference")
}

func TestCommands_FormValuesLimitedCountLengthCharactersKeys(t *testing.T) {
	cmdTBad(t, cmdTSubmit(cmdTRefs(21, "x")), "at most 20 fields")
	cmdTOk(t, cmdTSubmit(cmdTRefs(20, "x")))
	cmdTBad(t, cmdTSubmit(cmdTMap{"e2": strings.Repeat("x", 101)}), "at most 100 characters")
	cmdTOk(t, cmdTSubmit(cmdTMap{"e2": strings.Repeat("x", 100)}))
	for _, v := range []string{"a\nb", "a\u0000b", "a\u001fb", "a\u007fb", "a\u0085b", "a\tb"} {
		cmdTBad(t, cmdTSubmit(cmdTMap{"e2": v}), "control characters")
	}
	cmdTBad(t, cmdTSubmit(cmdTMap{"e2": 5.0}), "must be strings")
	cmdTBad(t, cmdTSubmit(cmdTMap{"name": "x"}), "keys must be element references")
	cmdTBad(t, cmdTSubmit([]any{"x"}), "must be an object")
	cmdTBad(t, cmdTSubmit(nil), "must be an object")
	// non-ASCII text is fine
	cmdTOk(t, cmdTSubmit(cmdTMap{"e2": "Привет 日本語 😀"}))
	// the length is counted in UTF-16 units, as JavaScript's String.length does: an emoji is two units
	cmdTOk(t, cmdTSubmit(cmdTMap{"e2": strings.Repeat("😀", 50)}))
	cmdTBad(t, cmdTSubmit(cmdTMap{"e2": strings.Repeat("😀", 51)}), "at most 100 characters")
	// characters just outside the control ranges are fine
	cmdTOk(t, cmdTSubmit(cmdTMap{"e2": "a b~b b"}))
}

func TestCommands_CanonicalFormSortedKeysNoWhitespace(t *testing.T) {
	a := cmdTOk(t, cmdTMap{"values": cmdTMap{"e6": "b", "e5": "a"}, "cmd": "submit_form", "id": "x", "form": "e4", "snap": 2.0})
	b := cmdTOk(t, cmdTMap{"snap": 2.0, "form": "e4", "id": "x", "cmd": "submit_form", "values": cmdTMap{"e5": "a", "e6": "b"}})
	if want := `{"cmd":"submit_form","form":"e4","id":"x","snap":2,"values":{"e5":"a","e6":"b"}}`; a.Canonical != want {
		t.Fatalf("canonical = %s", a.Canonical)
	}
	if a.Canonical != b.Canonical || a.SHA256 != b.SHA256 {
		t.Fatalf("input order changed the result: %s vs %s", a.Canonical, b.Canonical)
	}
	sum := sha256.Sum256([]byte(a.Canonical))
	if a.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("sha256 = %s", a.SHA256)
	}
	got, err := CanonicalJSON([]any{1.0, "a", cmdTMap{"b": []any{}, "a": nil}})
	if err != nil || got != `[1,"a",{"a":null,"b":[]}]` {
		t.Fatalf("canonical = %s, %v", got, err)
	}
	got, err = CanonicalJSON("é\"\\")
	if err != nil || got != `"é\"\\"` {
		t.Fatalf("canonical = %s, %v", got, err)
	}
	// numbers that are not integers have no canonical form
	for _, v := range []any{1.5, math.NaN(), math.Inf(-1), int(3), struct{}{}} {
		if s, err := CanonicalJSON(v); err == nil {
			t.Fatalf("CanonicalJSON(%v) = %s, want an error", v, s)
		}
	}
}

func TestCommands_AnyChangeToAnyFieldChangesHash(t *testing.T) {
	base := func(over cmdTMap) cmdTMap {
		m := cmdTMap{"cmd": "submit_form", "id": "x", "snap": 2.0, "form": "e4", "values": cmdTMap{"e5": "a"}}
		for k, v := range over {
			m[k] = v
		}
		return m
	}
	hashes := map[string]bool{cmdTOk(t, base(nil)).SHA256: true}
	for _, changed := range []cmdTMap{
		base(cmdTMap{"id": "y"}),
		base(cmdTMap{"snap": 3.0}),
		base(cmdTMap{"form": "e5"}),
		base(cmdTMap{"values": cmdTMap{"e5": "b"}}),
		base(cmdTMap{"values": cmdTMap{"e5": "a", "e6": ""}}),
		base(cmdTMap{"values": cmdTMap{"e6": "a"}}),
	} {
		hashes[cmdTOk(t, changed).SHA256] = true
	}
	if len(hashes) != 7 {
		t.Fatalf("%d distinct hashes, want 7", len(hashes))
	}
}

func TestCommands_KnownDigest(t *testing.T) {
	if got := sha256Hex(""); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("sha256 of empty = %s", got)
	}
	back := cmdTOk(t, cmdTMap{"cmd": "back", "id": "a"})
	if back.Canonical != `{"cmd":"back","id":"a"}` {
		t.Fatalf("canonical = %s", back.Canonical)
	}
	if back.SHA256 != sha256Hex(`{"cmd":"back","id":"a"}`) {
		t.Fatalf("sha256 = %s", back.SHA256)
	}
}

func TestCommands_LongerThan4KiBRejected(t *testing.T) {
	// 20 values of 100 characters of multi-byte text: about 20 * (100 * 3) bytes
	values := cmdTMap{}
	for i := 0; i < 20; i++ {
		values[fmt.Sprintf("e%d", i)] = strings.Repeat("日", 100)
	}
	cmdTBad(t, cmdTSubmit(values), "longer than 4096 bytes")
	// the same rule counts bytes, not characters: a command just under the limit passes
	ten := cmdTMap{}
	for i := 0; i < 10; i++ {
		ten[fmt.Sprintf("e%d", i)] = strings.Repeat("日", 100)
	}
	if c := cmdTOk(t, cmdTSubmit(ten)); len(c.Canonical) > 4096 || len(c.Canonical) < 3000 {
		t.Fatalf("canonical length %d", len(c.Canonical))
	}
}

func TestCommands_DigestComparisonIsStrict(t *testing.T) {
	d := sha256Hex("x")
	if !SameDigest(d, d) {
		t.Fatal("equal digests differ")
	}
	for name, a := range map[string]any{
		"upper case":   strings.ToUpper(d),
		"too short":    d[1:],
		"too long":     d + "0",
		"other digest": sha256Hex("y"),
		"number":       5.0,
		"undefined":    nil,
		"not hex":      strings.Repeat("z", 64),
		"empty":        "",
	} {
		if SameDigest(a, d) {
			t.Fatalf("%s: accepted", name)
		}
	}
}

// Conformance fixture: testdata/canonical.json was produced by the first (TypeScript) implementation over the
// inputs (the generator is gone with that implementation). The approval hash is a hash of these bytes, so any drift is a break.
func TestCommands_CanonicalFormMatchesFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/canonical.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Valid []struct {
			Input     json.RawMessage `json:"input"`
			Raw       string          `json:"raw"`
			Canonical string          `json:"canonical"`
			SHA256    string          `json:"sha256"`
		} `json:"valid"`
		Invalid []struct {
			Input   json.RawMessage `json:"input"`
			Raw     string          `json:"raw"`
			Error   string          `json:"error"`
			Ordered bool            `json:"ordered"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Valid) < 40 || len(fx.Invalid) < 40 {
		t.Fatalf("fixture too small: %d valid, %d invalid", len(fx.Valid), len(fx.Invalid))
	}
	decode := func(input json.RawMessage, raw string) any {
		text := string(input)
		if raw != "" {
			text = raw
		}
		var v any
		if err := json.Unmarshal([]byte(text), &v); err != nil {
			t.Fatalf("decoding %.80s: %v", text, err)
		}
		return v
	}
	types := map[string]bool{}
	for i, c := range fx.Valid {
		v := decode(c.Input, c.Raw)
		got, problem := ValidateCommand(v)
		if problem != "" {
			t.Errorf("valid #%d %.80s rejected: %s", i, c.Input, problem)
			continue
		}
		if got.Canonical != c.Canonical {
			t.Errorf("valid #%d %.80s: canonical\n got  %q\n want %q", i, c.Input, got.Canonical, c.Canonical)
		}
		if got.SHA256 != c.SHA256 {
			t.Errorf("valid #%d %.80s: sha256 %s, want %s", i, c.Input, got.SHA256, c.SHA256)
		}
		if got.SHA256 != sha256Hex(got.Canonical) {
			t.Errorf("valid #%d: sha256 is not the digest of the canonical form", i)
		}
		types[got.Cmd] = true
	}
	if want := CommandNames(); len(types) != len(want) {
		t.Errorf("fixture covers %d command types, want %d", len(types), len(want))
	}
	for i, c := range fx.Invalid {
		v := decode(c.Input, c.Raw)
		_, problem := ValidateCommand(v)
		if problem == "" {
			t.Errorf("invalid #%d %.80s accepted", i, c.Input)
			continue
		}
		// with several offending keys Go reports the first in
		// sorted order, since a decoded map has no order: such cases only have to be rejected
		if c.Ordered && problem != c.Error {
			t.Errorf("invalid #%d %.80s: error %q, fixture says %q", i, c.Input, problem, c.Error)
		}
	}
}

func TestCommands_SizeLimitIsExactly4096Bytes(t *testing.T) {
	// 13 full-width fields and one ASCII field whose length is tuned until the canonical form is exactly 4096 bytes
	build := func(pad int) cmdTMap {
		values := cmdTMap{}
		for i := 0; i < 13; i++ {
			values[fmt.Sprintf("e%d", i)] = strings.Repeat("日", 100)
		}
		values["e13"] = strings.Repeat("x", pad)
		return cmdTSubmit(values)
	}
	pad := -1
	for p := 0; p <= 100; p++ {
		if s, err := CanonicalJSON(build(p)); err == nil && len(s) == 4096 {
			pad = p
			break
		}
	}
	if pad < 0 || pad == 100 {
		t.Fatalf("no padding gives exactly 4096 bytes (pad = %d)", pad)
	}
	if c := cmdTOk(t, build(pad)); len(c.Canonical) != 4096 {
		t.Fatalf("length = %d", len(c.Canonical))
	}
	cmdTBad(t, build(pad+1), "longer than 4096 bytes")
}
