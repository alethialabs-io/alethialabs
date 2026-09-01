// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"testing"
	"time"
)

// A waiver whose expiry cannot be read must not waive anything.
//
// Both builders used to swallow the time.Parse error and leave Expiry at its zero value, and both
// Covers implementations read a zero Expiry as "never expires". So `"expiry": "garbage"` produced
// a waiver that applied FOREVER — on the two gates that exist to block an apply.
//
// verify/override.go's own comment shows the class was known: it refuses a zero Expiry for the
// ControlPlanUnavailable backstop because "a payload merely omitting expiry" would "disable the
// backstop FOREVER". That defends the MISSING-expiry route into the zero value. An UNPARSEABLE
// expiry reached the same zero value by a different route, and nothing defended that one.

// malformedExpiries are values RFC3339 does not accept. Each previously produced a
// never-expiring waiver.
var malformedExpiries = []string{
	"garbage",
	"2026-13-45",                 // month 13, day 45
	"1756728000",                 // a unix timestamp, not a timestamp string
	"2026-09-01",                 // a date with no time — RFC3339 requires the full form
	"2026-09-01 12:00:00Z",       // a space instead of the T separator
	"2026-09-01T12:00:00",        // no zone offset
	"Tue, 01 Sep 2026 12:00:00Z", // RFC1123, not RFC3339
	"",                           // handled separately below: empty means "no expiry", which is legal
}

func TestBuildCompatOverrideRefusesAnUnreadableExpiry(t *testing.T) {
	for _, exp := range malformedExpiries {
		if exp == "" {
			continue // empty is the documented "no expiry" case, asserted below
		}
		t.Run(exp, func(t *testing.T) {
			ov := buildCompatOverride(map[string]any{
				"controls": []any{"COMPAT-K8S-CLOUD-AWS"},
				"expiry":   exp,
			})
			if ov != nil {
				t.Fatalf("an override with expiry %q was built; Expiry=%v, IsZero=%v — a zero Expiry waives forever",
					exp, ov.Expiry, ov.Expiry.IsZero())
			}
		})
	}
}

func TestBuildVerifyOverrideRefusesAnUnreadableExpiry(t *testing.T) {
	for _, exp := range malformedExpiries {
		if exp == "" {
			continue
		}
		t.Run(exp, func(t *testing.T) {
			ov := buildVerifyOverride(map[string]any{
				"controls": []any{"IAM-WILDCARD"},
				"expiry":   exp,
			})
			if ov != nil {
				t.Fatalf("an override with expiry %q was built; Expiry=%v, IsZero=%v — a zero Expiry waives forever",
					exp, ov.Expiry, ov.Expiry.IsZero())
			}
		})
	}
}

// The other direction. Refusing everything would satisfy the tables above, so the shapes that must
// still work are asserted too — an absent expiry is the documented "no expiry" case and stays legal.
func TestOverrideBuildersStillAcceptValidExpiries(t *testing.T) {
	valid := map[string]string{
		"an RFC3339 instant in UTC": "2099-01-01T00:00:00Z",
		"with a numeric offset":     "2099-01-01T00:00:00+02:00",
		"with fractional seconds":   "2099-01-01T00:00:00.123456Z",
	}
	for name, exp := range valid {
		t.Run("compat/"+name, func(t *testing.T) {
			ov := buildCompatOverride(map[string]any{"controls": []any{"C"}, "expiry": exp})
			if ov == nil {
				t.Fatalf("a valid expiry %q was refused", exp)
			}
			if ov.Expiry.IsZero() {
				t.Errorf("expiry %q parsed to the zero time, which reads as 'never expires'", exp)
			}
		})
		t.Run("verify/"+name, func(t *testing.T) {
			ov := buildVerifyOverride(map[string]any{"controls": []any{"C"}, "expiry": exp})
			if ov == nil {
				t.Fatalf("a valid expiry %q was refused", exp)
			}
			if ov.Expiry.IsZero() {
				t.Errorf("expiry %q parsed to the zero time", exp)
			}
		})
	}

	t.Run("an absent expiry still means no expiry", func(t *testing.T) {
		ov := buildCompatOverride(map[string]any{"controls": []any{"C"}})
		if ov == nil {
			t.Fatal("an override with no expiry was refused; omitting it is the documented no-expiry case")
		}
		if !ov.Expiry.IsZero() {
			t.Errorf("an absent expiry should leave the zero time, got %v", ov.Expiry)
		}
	})
}

// The whole point is what the GATE then does, not what the builder returns. This drives the two
// together, because a builder returning nil is only a fix if nil means "waives nothing".
func TestAnUnreadableExpiryLeavesTheControlBlocked(t *testing.T) {
	const ctl = "COMPAT-K8S-CLOUD-AWS"

	waives := buildCompatOverride(map[string]any{
		"controls": []any{ctl},
		"expiry":   "2099-01-01T00:00:00Z",
	})
	if waives == nil || !waives.CoversAt(ctl, time.Now()) {
		t.Fatal("a valid, unexpired waiver should cover its control — the test's control case is broken")
	}

	malformed := buildCompatOverride(map[string]any{
		"controls": []any{ctl},
		"expiry":   "garbage",
	})
	if malformed.CoversAt(ctl, time.Now()) {
		t.Error("a waiver with an unreadable expiry still covered its control — the apply would proceed")
	}
}
