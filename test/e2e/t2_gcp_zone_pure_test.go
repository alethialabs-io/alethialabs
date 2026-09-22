// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the gcp zone fallback — no cloud, no token, no CLI.
//
// The axis these vary is WHAT THE CANDIDATE ZONES SAID, and the properties they pin are the two
// that can silently cost money or silently hide a refusal:
//
//	a region-shaped entry must be REFUSED, because it triples the node count (#3566)
//	"nobody answered" must never render the same as "somebody answered no"
//
// The rotation tests additionally pin the one operational promise the picker makes: a re-run of the
// same run lands in a DIFFERENT zone. That is the maintainer's recovery path from a stockout, and
// it is one modular-arithmetic slip away from being a no-op that nothing would notice.
package e2e

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The real europe-west3-a answer in shape, trimmed. e2-medium is the floor's type.
var ew3Types = []string{"e2-micro", "e2-small", "e2-medium", "e2-standard-2", "n2-standard-2"}

func TestParseGCPZones(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    []string
		wantErr string
	}{
		{
			name: "comma separated",
			raw:  "europe-west3-a,europe-west3-b,europe-west3-c",
			want: []string{"europe-west3-a", "europe-west3-b", "europe-west3-c"},
		},
		{
			name: "whitespace separated and mixed",
			raw:  " europe-west3-a ,\n europe-west3-b\t europe-west3-c ",
			want: []string{"europe-west3-a", "europe-west3-b", "europe-west3-c"},
		},
		{
			name: "order is preserved, not sorted — the list is a preference order",
			raw:  "europe-west3-c,europe-west3-a",
			want: []string{"europe-west3-c", "europe-west3-a"},
		},
		{
			name: "duplicates collapse",
			raw:  "europe-west3-a,europe-west3-a,europe-west3-b",
			want: []string{"europe-west3-a", "europe-west3-b"},
		},
		{
			name: "case folds",
			raw:  "EUROPE-WEST3-A",
			want: []string{"europe-west3-a"},
		},
		{
			// THE COST REGRESSION. A region here makes the cluster regional, which delivers 3
			// nodes where the floor declares 1. It must be refused, never silently accepted.
			name:    "a region is refused",
			raw:     "europe-west3",
			wantErr: "is a region, not a zone",
		},
		{
			name:    "a region hiding among zones is still refused",
			raw:     "europe-west3-a,europe-west3,europe-west3-c",
			wantErr: "is a region, not a zone",
		},
		{
			name:    "us-east1 is a region too — one dash, not two",
			raw:     "us-east1",
			wantErr: "is a region, not a zone",
		},
		{
			name:    "an empty list is an error, not a silent default",
			raw:     "  , ,\t",
			wantErr: "no zone at all",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseGCPZones(tc.raw)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("ParseGCPZones(%q) = %v, want an error containing %q", tc.raw, got, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("ParseGCPZones(%q) error = %q, want it to contain %q", tc.raw, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseGCPZones(%q) unexpected error: %v", tc.raw, err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("ParseGCPZones(%q) = %v, want %v", tc.raw, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("ParseGCPZones(%q) = %v, want %v", tc.raw, got, tc.want)
				}
			}
		})
	}
}

// TestDefaultGCPZonesAreZonesAndParse holds the shipped default to its own rule. A default that
// could not survive ParseGCPZones would be a cost regression shipped as a constant.
func TestDefaultGCPZonesAreZonesAndParse(t *testing.T) {
	got, err := ParseGCPZones(strings.Join(DefaultGCPZones, ","))
	if err != nil {
		t.Fatalf("DefaultGCPZones does not survive its own parser: %v", err)
	}
	if len(got) != len(DefaultGCPZones) {
		t.Fatalf("DefaultGCPZones has a duplicate: parsed %v from %v", got, DefaultGCPZones)
	}
	if len(DefaultGCPZones) < 2 {
		t.Fatalf("DefaultGCPZones has %d entry — a fallback list of one is the defect this fixes", len(DefaultGCPZones))
	}
	// The first entry must stay the historically hardcoded zone, so an un-rotated run is
	// identical to the old behaviour and the change is a widening, not a move.
	if DefaultGCPZones[0] != "europe-west3-a" {
		t.Errorf("DefaultGCPZones[0] = %q, want europe-west3-a (the zone the workflow used to hardcode)", DefaultGCPZones[0])
	}
}

func TestRotateGCPZones(t *testing.T) {
	zones := []string{"a", "b", "c"}
	tests := []struct {
		offset int
		want   string
	}{
		{0, "a b c"},
		{1, "b c a"},
		{2, "c a b"},
		{3, "a b c"},  // wraps
		{-1, "c a b"}, // negative offsets wrap the other way rather than panicking
	}
	for _, tc := range tests {
		got := strings.Join(RotateGCPZones(zones, tc.offset), " ")
		if got != tc.want {
			t.Errorf("RotateGCPZones(%v, %d) = %q, want %q", zones, tc.offset, got, tc.want)
		}
	}
	if got := RotateGCPZones(nil, 1); got != nil {
		t.Errorf("RotateGCPZones(nil, 1) = %v, want nil", got)
	}
	// Rotation must PERMUTE, never drop: every candidate has to stay reachable or the fallback
	// list is shorter than it reads.
	for offset := 0; offset < 7; offset++ {
		got := RotateGCPZones(zones, offset)
		if len(got) != len(zones) {
			t.Fatalf("RotateGCPZones(%v, %d) returned %d zone(s), want %d", zones, offset, len(got), len(zones))
		}
		seen := map[string]bool{}
		for _, z := range got {
			seen[z] = true
		}
		if len(seen) != len(zones) {
			t.Fatalf("RotateGCPZones(%v, %d) = %v — it dropped or duplicated a zone", zones, offset, got)
		}
	}
}

// TestGCPZoneRotationOffsetMovesOnReRun is the operational promise: "re-run failed jobs" on a
// stocked-out leg must land somewhere else. Same run id, next attempt, different zone.
func TestGCPZoneRotationOffsetMovesOnReRun(t *testing.T) {
	const n = 3
	for _, runID := range []uint64{0, 1, 35580334231, 35499891484} {
		first := GCPZoneRotationOffset(runID, 1, n)
		second := GCPZoneRotationOffset(runID, 2, n)
		if first == second {
			t.Errorf("run %d: attempt 1 and attempt 2 both chose offset %d — a re-run would retry the same stocked-out zone", runID, first)
		}
		third := GCPZoneRotationOffset(runID, 3, n)
		if third == first || third == second {
			t.Errorf("run %d: attempt 3 offset %d repeats attempt 1 (%d) or 2 (%d) before the list is exhausted", runID, third, first, second)
		}
	}
	// attempt 0 is not a thing GitHub produces, but it must not fold onto attempt 2.
	if GCPZoneRotationOffset(7, 0, n) != GCPZoneRotationOffset(7, 1, n) {
		t.Error("attempt 0 should be treated as attempt 1")
	}
	// Every offset must be a valid index; n <= 0 must not divide by zero.
	for _, id := range []uint64{0, 1, 2, 99, 35580334231} {
		if off := GCPZoneRotationOffset(id, 1, n); off < 0 || off >= n {
			t.Errorf("GCPZoneRotationOffset(%d, 1, %d) = %d — out of range", id, n, off)
		}
	}
	if off := GCPZoneRotationOffset(5, 1, 0); off != 0 {
		t.Errorf("GCPZoneRotationOffset with n=0 = %d, want 0", off)
	}
}

// offersFrom builds a probe from a per-zone table. A zone absent from the table returns an error
// (the probe did not answer); a zone mapped to nil returns nil, nil (the same, via the other door);
// a zone mapped to an empty slice is the cloud answering that it offers nothing.
func offersFrom(table map[string][]string) GCPZoneOffersFunc {
	return func(_ context.Context, zone string) ([]string, error) {
		v, ok := table[zone]
		if !ok {
			return nil, errors.New("gcloud: no answer")
		}
		return v, nil
	}
}

func TestChooseGCPZone(t *testing.T) {
	ctx := context.Background()
	zones := []string{"europe-west3-a", "europe-west3-b", "europe-west3-c"}

	t.Run("the first zone that lists the type wins, and later zones are not asked", func(t *testing.T) {
		asked := []string{}
		probe := func(_ context.Context, zone string) ([]string, error) {
			asked = append(asked, zone)
			return ew3Types, nil
		}
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", probe)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Zone != "europe-west3-a" || got.Verdict != GCPZoneConfirmed {
			t.Fatalf("got %s [%s], want europe-west3-a [CONFIRMED]", got.Zone, got.Verdict)
		}
		if len(asked) != 1 {
			t.Errorf("asked %v — a confirmed zone must stop the walk, not probe the rest", asked)
		}
	})

	t.Run("a zone that answers without the type is skipped for one that has it", func(t *testing.T) {
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", offersFrom(map[string][]string{
			"europe-west3-a": {"n2-standard-2"},
			"europe-west3-b": ew3Types,
			"europe-west3-c": ew3Types,
		}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Zone != "europe-west3-b" || got.Verdict != GCPZoneConfirmed {
			t.Fatalf("got %s [%s], want europe-west3-b [CONFIRMED]", got.Zone, got.Verdict)
		}
	})

	t.Run("an empty answer is an ANSWER and is skipped, not treated as no answer", func(t *testing.T) {
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", offersFrom(map[string][]string{
			"europe-west3-a": {},
			"europe-west3-b": {},
			"europe-west3-c": ew3Types,
		}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Zone != "europe-west3-c" {
			t.Fatalf("got %s, want europe-west3-c", got.Zone)
		}
	})

	t.Run("every zone answers and none sells it — REFUSE before any spend", func(t *testing.T) {
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", offersFrom(map[string][]string{
			"europe-west3-a": {"n2-standard-2"},
			"europe-west3-b": {},
			"europe-west3-c": {"n2-standard-2"},
		}))
		if err == nil {
			t.Fatalf("got %s [%s] with no error — a unanimous answer of \"no\" must refuse before the apply", got.Zone, got.Verdict)
		}
		if got.Zone != "" {
			t.Errorf("a refusal returned zone %q — a refused choice must name no zone", got.Zone)
		}
		for _, want := range []string{"e2-medium", "NONE", "before any spend"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("refusal %q does not say %q", err, want)
			}
		}
	})

	t.Run("nobody answered — UNVERIFIED on the first candidate, never a refusal", func(t *testing.T) {
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", offersFrom(map[string][]string{}))
		if err != nil {
			t.Fatalf("a probe that did not answer must not red the run: %v", err)
		}
		if got.Zone != "europe-west3-a" || got.Verdict != GCPZoneUnverified {
			t.Fatalf("got %s [%s], want europe-west3-a [UNVERIFIED]", got.Zone, got.Verdict)
		}
		if !strings.Contains(got.Detail, "UNVERIFIED") {
			t.Errorf("detail %q does not say the check did not run", got.Detail)
		}
	})

	t.Run("a nil list is no answer, not an empty one", func(t *testing.T) {
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", offersFrom(map[string][]string{
			"europe-west3-a": nil,
			"europe-west3-b": nil,
			"europe-west3-c": nil,
		}))
		if err != nil {
			t.Fatalf("nil lists must be UNKNOWN, not a refusal: %v", err)
		}
		if got.Verdict != GCPZoneUnverified {
			t.Fatalf("got [%s], want [UNVERIFIED] — a nil list is the absence of an answer", got.Verdict)
		}
	})

	t.Run("a mix of no-answer and answered-without prefers the no-answer zone", func(t *testing.T) {
		// europe-west3-a cannot be asked; b and c both answered and neither sells it. The zone
		// that was never ruled OUT is the better bet, and the detail must say both halves.
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", offersFrom(map[string][]string{
			"europe-west3-b": {"n2-standard-2"},
			"europe-west3-c": {"n2-standard-2"},
		}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Zone != "europe-west3-a" || got.Verdict != GCPZoneUnverified {
			t.Fatalf("got %s [%s], want europe-west3-a [UNVERIFIED]", got.Zone, got.Verdict)
		}
		if !strings.Contains(got.Detail, "2 answered without it") {
			t.Errorf("detail %q does not report how many zones were ruled out", got.Detail)
		}
	})

	t.Run("no machine type means nothing was checked, and it says so", func(t *testing.T) {
		got, err := ChooseGCPZone(ctx, zones, "  ", offersFrom(map[string][]string{"europe-west3-a": ew3Types}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Verdict != GCPZoneUnverified {
			t.Fatalf("got [%s], want [UNVERIFIED] — nothing to check is not a clean check", got.Verdict)
		}
	})

	t.Run("no probe means nothing was checked", func(t *testing.T) {
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Zone != "europe-west3-a" || got.Verdict != GCPZoneUnverified {
			t.Fatalf("got %s [%s], want europe-west3-a [UNVERIFIED]", got.Zone, got.Verdict)
		}
	})

	t.Run("no candidates at all is an error", func(t *testing.T) {
		if _, err := ChooseGCPZone(ctx, nil, "e2-medium", offersFrom(nil)); err == nil {
			t.Fatal("an empty candidate list must be an error, not a silent empty zone")
		}
	})
}

// TestChooseGCPZoneDetailIsAlwaysPopulated holds the same rule preflightResult.Detail holds: a
// check whose success says nothing cannot be told apart from a check that never ran.
func TestChooseGCPZoneDetailIsAlwaysPopulated(t *testing.T) {
	ctx := context.Background()
	zones := []string{"europe-west3-a", "europe-west3-b"}
	cases := map[string]GCPZoneOffersFunc{
		"confirmed":  offersFrom(map[string][]string{"europe-west3-a": ew3Types}),
		"unverified": offersFrom(map[string][]string{}),
	}
	for name, probe := range cases {
		got, err := ChooseGCPZone(ctx, zones, "e2-medium", probe)
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", name, err)
		}
		if strings.TrimSpace(got.Detail) == "" {
			t.Errorf("%s: Detail is empty", name)
		}
		if got.Verdict == "" {
			t.Errorf("%s: Verdict is empty", name)
		}
		if len(got.Considered) != len(zones) {
			t.Errorf("%s: Considered = %v, want all %d candidates so the reader can see what was passed over", name, got.Considered, len(zones))
		}
	}
}

// TestGCPZoneVerdictsAreDistinct — three names that all render the same would reintroduce exactly
// the collapse the preflight's own verdicts exist to prevent.
func TestGCPZoneVerdictsAreDistinct(t *testing.T) {
	seen := map[GCPZoneChoiceVerdict]bool{}
	for _, v := range []GCPZoneChoiceVerdict{GCPZoneConfirmed, GCPZoneUnverified, GCPZonePinned} {
		if v == "" {
			t.Error("a verdict is empty")
		}
		if seen[v] {
			t.Errorf("verdict %q is duplicated", v)
		}
		seen[v] = true
	}
}
