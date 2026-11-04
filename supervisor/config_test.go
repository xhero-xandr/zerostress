package main

import (
	"regexp"
	"testing"
	"time"
)

// The boundaries of every session setting.

func TestConfig_SessionSettingsDefaults(t *testing.T) {
	c, err := LoadConfig(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		name      string
		got, want any
	}{
		{"SessionSlots", c.SessionSlots, 1},
		{"SessionIdle", c.SessionIdle, 60 * time.Second},
		{"SessionMax", c.SessionMax, 300 * time.Second},
		{"SessionGrace", c.SessionGrace, 30 * time.Second},
		{"ApprovalTTL", c.ApprovalTTL, 300 * time.Second},
		{"CommandMax", c.CommandMax, 190},
		{"CommandTimeout", c.CommandTimeout, 30 * time.Second},
	}
	for _, k := range checks {
		if k.got != k.want {
			t.Errorf("%s = %v, want %v", k.name, k.got, k.want)
		}
	}
}

func TestConfig_SessionSettingsReadAndConvertedToDurations(t *testing.T) {
	c, err := LoadConfig(map[string]string{
		"SUP_SESSION_SLOTS":     "2",
		"SUP_SESSION_IDLE_S":    "90",
		"SUP_SESSION_MAX_S":     "600",
		"SUP_SESSION_GRACE_S":   "10",
		"SUP_APPROVAL_TTL_S":    "120",
		"SUP_COMMAND_MAX":       "50",
		"SUP_COMMAND_TIMEOUT_S": "5",
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.SessionSlots != 2 || c.SessionIdle != 90*time.Second || c.SessionMax != 600*time.Second ||
		c.SessionGrace != 10*time.Second || c.ApprovalTTL != 120*time.Second || c.CommandMax != 50 || c.CommandTimeout != 5*time.Second {
		t.Fatalf("config = %+v", c)
	}
}

func TestConfig_OutOfRangeOrMalformedValuesStopTheService(t *testing.T) {
	bad := []map[string]string{
		{"SUP_SESSION_SLOTS": "5"},
		{"SUP_SESSION_SLOTS": "-1"},
		{"SUP_SESSION_IDLE_S": "4"},
		{"SUP_SESSION_IDLE_S": "121"},
		{"SUP_SESSION_MAX_S": "29"},
		{"SUP_SESSION_MAX_S": "601"},
		{"SUP_APPROVAL_TTL_S": "9"},
		{"SUP_APPROVAL_TTL_S": "3601"},
		// the agent forwards at most 200 lines per job; the supervisor keeps one for its own close
		{"SUP_COMMAND_MAX": "200"},
		{"SUP_COMMAND_MAX": "0"},
		{"SUP_COMMAND_TIMEOUT_S": "0"},
		{"SUP_COMMAND_TIMEOUT_S": "121"},
		{"SUP_SESSION_SLOTS": "one"},
		{"SUP_COMMAND_MAX": "1.5"},
		// same rules
		{"SUP_SESSION_GRACE_S": "0"},
		{"SUP_SESSION_GRACE_S": "121"},
		{"SUP_COMMAND_MAX": "99999999999999999999"},
		{"SUP_COMMAND_MAX": " 5"},
		{"SUP_COMMAND_MAX": "5\n"},
		{"SUP_COMMAND_MAX": "+5"},
	}
	must := regexp.MustCompile(`must be`)
	for _, env := range bad {
		_, err := LoadConfig(env)
		if err == nil {
			t.Errorf("%v: accepted", env)
			continue
		}
		if !must.MatchString(err.Error()) {
			t.Errorf("%v: error %q does not say what is required", env, err)
		}
	}
}

func TestConfig_ZeroSessionSlotsMeansSessionsOff(t *testing.T) {
	c, err := LoadConfig(map[string]string{"SUP_SESSION_SLOTS": "0"})
	if err != nil {
		t.Fatal(err)
	}
	if c.SessionSlots != 0 {
		t.Fatalf("SessionSlots = %d", c.SessionSlots)
	}
}

func TestConfig_BoundariesAreInclusiveAndEmptyMeansDefault(t *testing.T) {
	ok := []map[string]string{
		{"SUP_SESSION_SLOTS": "4"},
		{"SUP_SESSION_IDLE_S": "5"},
		{"SUP_SESSION_IDLE_S": "120"},
		{"SUP_SESSION_MAX_S": "30"},
		{"SUP_SESSION_MAX_S": "600"},
		{"SUP_SESSION_GRACE_S": "1"},
		{"SUP_SESSION_GRACE_S": "120"},
		{"SUP_APPROVAL_TTL_S": "10"},
		{"SUP_APPROVAL_TTL_S": "3600"},
		{"SUP_COMMAND_MAX": "1"},
		{"SUP_COMMAND_MAX": "199"},
		{"SUP_COMMAND_TIMEOUT_S": "1"},
		{"SUP_COMMAND_TIMEOUT_S": "120"},
	}
	for _, env := range ok {
		if _, err := LoadConfig(env); err != nil {
			t.Errorf("%v: %v", env, err)
		}
	}
	c, err := LoadConfig(map[string]string{"SUP_COMMAND_MAX": ""})
	if err != nil || c.CommandMax != 190 {
		t.Fatalf("empty value: %d, %v", c.CommandMax, err)
	}
}
