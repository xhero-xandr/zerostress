package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Session commands (spec 005, 3.3; spec 006, 3.8). The supervisor accepts only this fixed set with checked
// parameters. What it sends to the guest is the canonical form, so the SHA-256 an approval is bound to is the SHA-256
// of exactly the bytes that reach the collector. The canonical form is byte-identical to the TypeScript supervisor's.

type Risk string

const (
	RiskSafe  Risk = "safe"
	RiskRisky Risk = "risky"
)

var (
	commandIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	// refRe is `e7`, or `f1e3` for an element inside an iframe (Playwright aria refs).
	refRe        = regexp.MustCompile(`^(?:f\d{1,4})?e\d{1,9}$`)
	controlCharR = regexp.MustCompile(`[\x00-\x1f\x7f-\x{9f}]`)
)

const (
	maxCommandBytes = 4096
	maxValueFields  = 20
	maxValueChars   = 100
)

// fieldCheck returns "" when the value is acceptable, otherwise what is wrong with it.
type fieldCheck func(v any) string

type field struct {
	name  string
	check fieldCheck
}

func integer(min, max float64) fieldCheck {
	return func(v any) string {
		f, ok := v.(float64)
		if ok && f == math.Trunc(f) && f >= min && f <= max {
			return ""
		}
		return fmt.Sprintf("must be an integer from %d to %d", int64(min), int64(max))
	}
}

func boolean(v any) string {
	if _, ok := v.(bool); ok {
		return ""
	}
	return "must be true or false"
}

func ref(v any) string {
	if s, ok := v.(string); ok && refRe.MatchString(s) {
		return ""
	}
	return "must be an element reference like e7"
}

func formValues(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return "must be an object"
	}
	if len(m) > maxValueFields {
		return fmt.Sprintf("must have at most %d fields", maxValueFields)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !refRe.MatchString(k) {
			return "keys must be element references"
		}
		s, ok := m[k].(string)
		if !ok || len(utf16.Encode([]rune(s))) > maxValueChars {
			return fmt.Sprintf("values must be strings of at most %d characters", maxValueChars)
		}
		if controlCharR.MatchString(s) {
			return "values must not contain control characters"
		}
	}
	return ""
}

type cmdSpec struct {
	risk     Risk
	required []field
	optional []field
}

var snapField = field{"snap", integer(0, 1_000_000_000)}

var commandTable = map[string]cmdSpec{
	"snapshot":    {risk: RiskSafe},
	"scroll":      {risk: RiskSafe, required: []field{{"dy", integer(-5000, 5000)}}},
	"wait":        {risk: RiskSafe, required: []field{{"ms", integer(0, 5000)}}},
	"screenshot":  {risk: RiskSafe, optional: []field{{"full", boolean}}},
	"open_link":   {risk: RiskSafe, required: []field{snapField, {"ref", ref}}},
	"back":        {risk: RiskSafe},
	"close":       {risk: RiskSafe},
	"download":    {risk: RiskRisky, required: []field{snapField, {"ref", ref}}},
	"submit_form": {risk: RiskRisky, required: []field{snapField, {"form", ref}, {"values", formValues}}},
}

// ValidCommand is a command that passed validation, in the form that is sent and hashed.
type ValidCommand struct {
	ID        string
	Cmd       string
	Risk      Risk
	Canonical string
	SHA256    string
}

// CommandNames lists the accepted command types.
func CommandNames() []string {
	names := make([]string, 0, len(commandTable))
	for n := range commandTable {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// jsString writes a string exactly as JavaScript's JSON.stringify does: only the quote, the backslash and control
// characters below U+0020 are escaped, everything else (including U+007F and U+2028) is written as is.
func jsString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// CanonicalJSON writes v with sorted keys at every level, no whitespace, JSON strings as above and integer numbers
// only. v is a value decoded by encoding/json into any.
func CanonicalJSON(v any) (string, error) {
	var b strings.Builder
	if err := writeCanonical(&b, v); err != nil {
		return "", err
	}
	return b.String(), nil
}

func writeCanonical(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case string:
		b.WriteString(jsString(x))
	case float64:
		if x != math.Trunc(x) || math.IsInf(x, 0) {
			return fmt.Errorf("canonical form allows integers only")
		}
		if x == 0 {
			b.WriteString("0") // also for -0, as JSON.stringify does
		} else {
			b.WriteString(strconv.FormatFloat(x, 'f', -1, 64))
		}
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(jsString(k))
			b.WriteByte(':')
			if err := writeCanonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("value cannot be written in canonical form")
	}
	return nil
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ValidateCommand checks a decoded JSON value. On failure the second result says what is wrong.
func ValidateCommand(raw any) (ValidCommand, string) {
	o, ok := raw.(map[string]any)
	if !ok {
		return ValidCommand{}, "command must be a JSON object"
	}
	cmd, _ := o["cmd"].(string)
	spec, known := commandTable[cmd]
	if !known {
		return ValidCommand{}, "unknown command type"
	}
	id, _ := o["id"].(string)
	if !commandIDRe.MatchString(id) {
		return ValidCommand{}, "id must match [A-Za-z0-9_-]{1,64}"
	}
	allowed := map[string]bool{"cmd": true, "id": true}
	for _, f := range spec.required {
		allowed[f.name] = true
	}
	for _, f := range spec.optional {
		allowed[f.name] = true
	}
	keys := make([]string, 0, len(o))
	for k := range o {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !allowed[k] {
			if len(k) > 40 {
				k = k[:40]
			}
			return ValidCommand{}, "unknown field: " + k
		}
	}
	for _, f := range spec.required {
		v, present := o[f.name]
		if !present {
			return ValidCommand{}, "missing field: " + f.name
		}
		if problem := f.check(v); problem != "" {
			return ValidCommand{}, f.name + " " + problem
		}
	}
	for _, f := range spec.optional {
		if v, present := o[f.name]; present {
			if problem := f.check(v); problem != "" {
				return ValidCommand{}, f.name + " " + problem
			}
		}
	}
	canonical, err := CanonicalJSON(o)
	if err != nil {
		return ValidCommand{}, err.Error()
	}
	if len(canonical) > maxCommandBytes {
		return ValidCommand{}, fmt.Sprintf("command is longer than %d bytes", maxCommandBytes)
	}
	return ValidCommand{ID: id, Cmd: cmd, Risk: spec.risk, Canonical: canonical, SHA256: sha256Hex(canonical)}, ""
}

// SameDigest compares two hex digests in constant time. Anything that is not a lowercase hex string of the right
// length is simply not equal.
func SameDigest(a any, b string) bool {
	s, ok := a.(string)
	if !ok || len(s) != len(b) || strings.ToLower(s) != s {
		return false
	}
	x, err1 := hex.DecodeString(s)
	y, err2 := hex.DecodeString(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return subtle.ConstantTimeCompare(x, y) == 1
}
