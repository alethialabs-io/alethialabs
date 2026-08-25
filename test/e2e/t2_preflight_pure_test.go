// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PRE-SPEND capacity preflight — no cloud, no token, no CLI.
//
// The axis these vary is THE ANSWER THE CLOUD GAVE, not whether a credential was present.
// That distinction is the point: the failure this guard exists to stop had every credential
// wired and every flag set, and died anyway because nobody asked the one question whose
// answer was free. A test that varied the credential would have passed against the bug.
package e2e

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The real nbg1 answer, read from the live API on 2026-08-25. cx33 is absent; it is the type
// two paid applies asked for.
var nbg1Available = []string{"cax11", "cax21", "cax31", "cx23", "cpx22", "cpx32"}

func TestDecideTypeAvailability(t *testing.T) {
	tests := []struct {
		name      string
		want      string
		location  string
		available []string
		probeErr  error
		verdict   preflightVerdict
		mustSay   []string
	}{
		{
			// THE REGRESSION. Two hetzner runs died five minutes into a paid apply on this
			// exact pair, and the answer was one GET away.
			name: "cx33 in nbg1 is refused before any spend", want: "cx33", location: "nbg1",
			available: nbg1Available, verdict: preflightRefuse,
			mustSay: []string{"cx33", "NOT available", "nbg1", "cpx32"},
		},
		{
			name: "the replacement is allowed through", want: "cpx32", location: "nbg1",
			available: nbg1Available, verdict: preflightProceed,
			mustSay: []string{"cpx32", "available", "nbg1"},
		},
		{
			// fsn1 really answers with an empty list. An ANSWER of "nothing" must refuse —
			// it is the first region an operator retries in, and it can fill no order at all.
			name: "an EMPTY availability list is an answer, and refuses", want: "cpx32", location: "fsn1",
			available: []string{}, verdict: preflightRefuse,
			mustSay: []string{"NOTHING", "fsn1"},
		},
		{
			// ...and the nil case must NOT refuse. Collapsing these two is the bug class.
			name: "a NIL list is the absence of an answer, and is unknown", want: "cpx32", location: "fsn1",
			available: nil, verdict: preflightUnknown,
			mustSay: []string{"UNVERIFIED", "NOT checked"},
		},
		{
			name: "a probe error never reds the run", want: "cpx32", location: "nbg1",
			available: nbg1Available, probeErr: errors.New("dial tcp: i/o timeout"),
			verdict: preflightUnknown,
			mustSay: []string{"UNVERIFIED", "i/o timeout"},
		},
		{
			name: "nothing to check is not a clean check", want: "  ", location: "nbg1",
			available: nbg1Available, verdict: preflightUnknown,
			mustSay: []string{"nothing was checked"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideTypeAvailability("probe", tc.want, tc.location, tc.available, tc.probeErr)
			if got.Verdict != tc.verdict {
				t.Errorf("verdict = %q, want %q\ndetail: %s", got.Verdict, tc.verdict, got.Detail)
			}
			// EVERY branch must say something. A check whose success is silent cannot be
			// told apart from a check that never ran, which is the defect this file guards.
			if strings.TrimSpace(got.Detail) == "" {
				t.Error("Detail is empty — a verdict with no sentence is indistinguishable from no verdict")
			}
			if got.Probe == "" {
				t.Error("Probe is empty — a reader cannot repeat the question by hand")
			}
			for _, want := range tc.mustSay {
				if !strings.Contains(got.Detail, want) {
					t.Errorf("detail does not mention %q\ngot: %s", want, got.Detail)
				}
			}
		})
	}
}

// TestDecideTypeAvailabilityVerdictsAreDistinct is the vacuity guard: the table above would
// also "pass" if every branch returned the same verdict under three different names.
func TestDecideTypeAvailabilityVerdictsAreDistinct(t *testing.T) {
	seen := map[preflightVerdict]bool{
		decideTypeAvailability("p", "cpx32", "nbg1", nbg1Available, nil).Verdict:     true,
		decideTypeAvailability("p", "cx33", "nbg1", nbg1Available, nil).Verdict:      true,
		decideTypeAvailability("p", "cx33", "nbg1", nil, errors.New("boom")).Verdict: true,
	}
	if len(seen) != 3 {
		t.Fatalf("the three verdicts collapse into %d distinct value(s): %v", len(seen), seen)
	}
}

// TestHcloudAvailableTypeNames pins the id→name join and, above all, the SUPPORTED-vs-AVAILABLE
// distinction — the thing that made this trap invisible. cx33 is supported in nbg1 and available
// in no datacenter, so a join that read `supported` would have waved through the exact apply
// that failed.
func TestHcloudAvailableTypeNames(t *testing.T) {
	types := []hcloudServerType{
		{ID: 114, Name: "cx23"}, {ID: 115, Name: "cx33"},
		{ID: 109, Name: "cpx22"}, {ID: 110, Name: "cpx32"},
	}
	dcs := []hcloudDatacenter{
		mkDC("nbg1-dc3", "nbg1", []int64{114, 109, 110}, []int64{114, 115, 109, 110}),
		mkDC("fsn1-dc14", "fsn1", []int64{}, []int64{114, 115}),
	}

	t.Run("reads available, never supported", func(t *testing.T) {
		got := hcloudAvailableTypeNames(dcs, types, "nbg1")
		if contains(got, "cx33") {
			t.Errorf("cx33 is in nbg1's SUPPORTED list and not its AVAILABLE list; the join must not return it: %v", got)
		}
		if !contains(got, "cpx32") {
			t.Errorf("cpx32 is available in nbg1 and is missing: %v", got)
		}
	})

	t.Run("matches the datacenter name too", func(t *testing.T) {
		if got := hcloudAvailableTypeNames(dcs, types, "nbg1-dc3"); !contains(got, "cpx32") {
			t.Errorf("a datacenter-shaped location must match: %v", got)
		}
	})

	t.Run("a matched but empty location returns non-nil, so it REFUSES", func(t *testing.T) {
		got := hcloudAvailableTypeNames(dcs, types, "fsn1")
		if got == nil {
			t.Fatal("fsn1 matched and is genuinely empty — returning nil would report UNKNOWN and let the run spend")
		}
		if len(got) != 0 {
			t.Fatalf("want an empty answer, got %v", got)
		}
		if v := decideTypeAvailability("p", "cpx32", "fsn1", got, nil).Verdict; v != preflightRefuse {
			t.Errorf("an empty fsn1 must REFUSE, got %q", v)
		}
	})

	t.Run("an unmatched location returns nil, so it is UNKNOWN", func(t *testing.T) {
		got := hcloudAvailableTypeNames(dcs, types, "nowhere1")
		if got != nil {
			t.Fatalf("a location we did not find must be nil (unknown), not empty (refuse): %v", got)
		}
		if v := decideTypeAvailability("p", "cpx32", "nowhere1", got, nil).Verdict; v != preflightUnknown {
			t.Errorf("an unmatched location must be UNKNOWN, got %q", v)
		}
	})

	t.Run("an id with no name is dropped rather than invented", func(t *testing.T) {
		got := hcloudAvailableTypeNames(
			[]hcloudDatacenter{mkDC("x-dc1", "x", []int64{114, 999}, nil)}, types, "x")
		if contains(got, "999") || len(got) != 1 {
			t.Errorf("an unknown server-type id must be dropped: %v", got)
		}
	})
}

func TestRenderOffer(t *testing.T) {
	if got := renderOffer(nil); !strings.Contains(got, "NOTHING") {
		t.Errorf("an empty offer must read as the finding it is, got %q", got)
	}
	if got := renderOffer([]string{"b", "a"}); got != "a, b" {
		t.Errorf("offers must be sorted for a stable message, got %q", got)
	}
	many := make([]string, preflightOfferSample+5)
	for i := range many {
		many[i] = string(rune('a'+i%26)) + string(rune('0'+i/26))
	}
	got := renderOffer(many)
	if !strings.Contains(got, "+5 more") {
		t.Errorf("a long offer list must be bounded and say how much was elided, got %q", got)
	}
}

func TestSnapshotInstanceType(t *testing.T) {
	tests := []struct {
		name string
		snap map[string]any
		want string
	}{
		{"pinned", map[string]any{"cluster": map[string]any{"instance_types": []any{"cpx32", "cpx22"}}}, "cpx32"},
		{"trimmed", map[string]any{"cluster": map[string]any{"instance_types": []any{"  cpx32 "}}}, "cpx32"},
		{"no cluster block", map[string]any{}, ""},
		{"empty list", map[string]any{"cluster": map[string]any{"instance_types": []any{}}}, ""},
		{"not a string", map[string]any{"cluster": map[string]any{"instance_types": []any{7}}}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := snapshotInstanceType(tc.snap); got != tc.want {
				t.Errorf("snapshotInstanceType = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestCapacityPreflightUnpinnedTypeSaysSo pins the honest no-op: a floor run pins no
// instance_types, and the guard must say the default was NOT checked rather than pass silently.
func TestCapacityPreflightUnpinnedTypeSaysSo(t *testing.T) {
	fatal, msg := t2RequireCapacityPreflight(context.Background(), "hetzner", "nbg1", map[string]any{})
	if fatal {
		t.Error("an unpinned instance type must never be fatal — the floor does not pin one")
	}
	if !strings.Contains(msg, "NOT checked") {
		t.Errorf("the message must record that nothing was checked, got %q", msg)
	}
}

// TestCapacityPreflightForUnknownProviderIsUnknown — a cloud with no probe has not been
// checked, and must never read as if it had.
func TestCapacityPreflightForUnknownProviderIsUnknown(t *testing.T) {
	got := capacityPreflightFor(context.Background(), "nosuchcloud", "somewhere", "big.type")
	if got.Verdict != preflightUnknown {
		t.Errorf("verdict = %q, want %q", got.Verdict, preflightUnknown)
	}
	if !strings.Contains(got.Detail, "UNVERIFIED") {
		t.Errorf("detail must say the run is unverified, got %q", got.Detail)
	}
}

// TestGCPRegionShapedLocationIsUnknown — machine-type availability is zonal. Handing a region
// would list nothing and REFUSE a run that is perfectly fine, so the shape is checked first.
func TestGCPRegionShapedLocationIsUnknown(t *testing.T) {
	got := gcpCapacityPreflight(context.Background(), "europe-west3", "e2-standard-4")
	if got.Verdict != preflightUnknown {
		t.Errorf("a region-shaped location must be UNKNOWN, not %q (%s)", got.Verdict, got.Detail)
	}
}

func mkDC(name, location string, available, supported []int64) hcloudDatacenter {
	var dc hcloudDatacenter
	dc.Name = name
	dc.Location.Name = location
	dc.ServerTypes.Available = available
	dc.ServerTypes.Supported = supported
	return dc
}

// ── The fail-open paths, exercised without a cloud ───────────────────────────────────────────
//
// These are the branches that decide whether a broken probe reds the nightly. They are the
// most important ones to pin and the easiest to leave untested, because they look like plumbing.

func TestHcloudGetJSONRefusesAnEmptyToken(t *testing.T) {
	// No network is reached: an empty token is refused before the request is built, which is
	// what keeps a credential-less local run from hanging on a DNS lookup.
	var out struct{}
	err := hcloudGetJSON(context.Background(), "  ", "datacenters", &out)
	if err == nil {
		t.Fatal("an empty HCLOUD_TOKEN must be an error, not an empty answer")
	}
	if !strings.Contains(err.Error(), "HCLOUD_TOKEN") {
		t.Errorf("the error must name what is missing, got %q", err)
	}
	// And it must arrive at the decision as UNKNOWN — never as a refusal.
	if v := decideTypeAvailability("p", "cpx32", "nbg1", nil, err).Verdict; v != preflightUnknown {
		t.Errorf("a missing token must be UNKNOWN, got %q", v)
	}
}

func TestHcloudAllServerTypesRefusesAnEmptyToken(t *testing.T) {
	if _, err := hcloudAllServerTypes(context.Background(), ""); err == nil {
		t.Fatal("want an error with no token")
	}
}

func TestHetznerCapacityPreflightWithoutATokenIsUnknown(t *testing.T) {
	t.Setenv("HCLOUD_TOKEN", "")
	got := hetznerCapacityPreflight(context.Background(), "nbg1", "cpx32")
	if got.Verdict != preflightUnknown {
		t.Fatalf("verdict = %q, want UNKNOWN — a run with no token must not be REFUSED by the capacity gate (its credential gate is what refuses it, with a message that names the token)", got.Verdict)
	}
}

func TestPreflightCLIStrings(t *testing.T) {
	ctx := context.Background()

	t.Run("decodes a JSON array", func(t *testing.T) {
		got, err := preflightCLIStrings(ctx, "printf", `%s`, `["cpx22","cpx32"]`)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 2 || got[0] != "cpx22" {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("an EMPTY array is an answer, not an error", func(t *testing.T) {
		got, err := preflightCLIStrings(ctx, "printf", `%s`, `[]`)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got == nil {
			t.Fatal("an empty array must decode to a non-nil empty slice, or the location would report UNKNOWN when the cloud said 'nothing'")
		}
		if v := decideTypeAvailability("p", "cpx32", "somewhere", got, nil).Verdict; v != preflightRefuse {
			t.Errorf("an empty answer must REFUSE, got %q", v)
		}
	})

	t.Run("JSON null is NOT an empty answer", func(t *testing.T) {
		if _, err := preflightCLIStrings(ctx, "printf", `%s`, `null`); err == nil {
			t.Fatal("null must be an error — it decodes into a nil slice, which downstream means UNKNOWN, and silently agreeing with that hides a broken query")
		}
	})

	t.Run("a non-JSON body is an error", func(t *testing.T) {
		if _, err := preflightCLIStrings(ctx, "printf", `%s`, `ERROR: not logged in`); err == nil {
			t.Fatal("an unparseable body must be an error, never an empty list")
		}
	})

	t.Run("a missing binary is an error, and the run proceeds UNVERIFIED", func(t *testing.T) {
		_, err := preflightCLIStrings(ctx, "definitely-not-a-real-cloud-cli-9f3a")
		if err == nil {
			t.Fatal("want an error for a missing CLI")
		}
		if v := decideTypeAvailability("p", "m5.large", "us-east-1", nil, err).Verdict; v != preflightUnknown {
			t.Errorf("a CLI that is not installed must be UNKNOWN, not REFUSE — it says nothing about capacity, got %q", v)
		}
	})
}

// TestManagedCloudProbesAreUnknownWithoutACLI pins the posture for all three managed clouds at
// once: with no authenticated CLI on the box, each must report UNKNOWN. A REFUSE here would red
// every local run for a reason that has nothing to do with the cloud.
func TestManagedCloudProbesAreUnknownWithoutACLI(t *testing.T) {
	// PATH is emptied so whichever cloud CLIs happen to be installed on the machine running
	// this test cannot change the outcome — the assertion is about the code, not the laptop.
	t.Setenv("PATH", "")
	for _, provider := range []string{"aws", "gcp", "azure"} {
		t.Run(provider, func(t *testing.T) {
			location := "us-east-1"
			if provider == "gcp" {
				location = "europe-west3-a"
			}
			got := capacityPreflightFor(context.Background(), provider, location, "some.type")
			if got.Verdict == preflightRefuse {
				t.Fatalf("an absent CLI must never REFUSE: %s", got.Detail)
			}
			if strings.TrimSpace(got.Detail) == "" {
				t.Error("Detail is empty")
			}
		})
	}
}

// TestDecideZoneAvailability pins the sibling decision for the per-ZONE probe. Same three verdicts
// and, critically, the same nil-vs-empty distinction: an empty list is the cloud answering "no zone
// here sells it" and is a REFUSAL, while a nil list is the probe having produced no answer and is
// not. A `len(zones) == 0` test would collapse the strongest evidence available into an
// unverified pass — the mistake that would make this check worthless on the case it exists for.
func TestDecideZoneAvailability(t *testing.T) {
	for _, tc := range []struct {
		name    string
		zones   []string
		err     error
		want    preflightVerdict
		mustSay string
	}{
		{
			name:    "offered in some zones proceeds and says how many",
			zones:   []string{"us-east-1a", "us-east-1c"},
			want:    preflightProceed,
			mustSay: "2 availability zone(s)",
		},
		{
			// THE POINT. Empty is an ANSWER: no zone in this region sells it.
			name:    "offered in no zone is a refusal, not an unknown",
			zones:   []string{},
			want:    preflightRefuse,
			mustSay: "NO availability zone",
		},
		{
			// ...and nil is the ABSENCE of an answer, which must never read as a refusal or a pass.
			name:    "a nil list is unknown, never a refusal",
			zones:   nil,
			want:    preflightUnknown,
			mustSay: "NOT checked",
		},
		{
			name:    "a probe error is unknown and carries the cause",
			zones:   nil,
			err:     errors.New("could not connect"),
			want:    preflightUnknown,
			mustSay: "could not connect",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := decideZoneAvailability("probe", "m5.large", "us-east-1", tc.zones, tc.err)
			if got.Verdict != tc.want {
				t.Errorf("verdict = %q, want %q (detail: %s)", got.Verdict, tc.want, got.Detail)
			}
			if !strings.Contains(got.Detail, tc.mustSay) {
				t.Errorf("detail must mention %q, got: %s", tc.mustSay, got.Detail)
			}
			if got.Detail == "" {
				t.Error("Detail is always non-empty — a check whose result says nothing cannot be told from one that never ran")
			}
		})
	}
}

// TestDecideZoneAvailabilityProceedDoesNotOverstate keeps the PROCEED honest. The run's own subnets
// are not resolved here, so "offered in some zone" is not "will work in the zone this cluster lands
// in" — and an EKS node group lands in specific subnets. The detail has to carry that gap, or a
// green preflight becomes a guarantee it cannot make.
func TestDecideZoneAvailabilityProceedDoesNotOverstate(t *testing.T) {
	got := decideZoneAvailability("probe", "m5.large", "us-east-1", []string{"us-east-1a"}, nil)
	if got.Verdict != preflightProceed {
		t.Fatalf("verdict = %q, want proceed", got.Verdict)
	}
	if !strings.Contains(got.Detail, "not that the zone this cluster lands in will") {
		t.Errorf("PROCEED must not read as a guarantee about the run's own zone, got: %s", got.Detail)
	}
}

// TestAlibabaCapacityPreflightIsANamedExclusion asserts alibaba is UNKNOWN with a message that says
// so by name. It routes through its own case rather than the unknown-provider default: an exclusion
// nobody named becomes a permanent one, and cloud parity is a hard rule in this repository.
func TestAlibabaCapacityPreflightIsANamedExclusion(t *testing.T) {
	got := capacityPreflightFor(context.Background(), "alibaba", "cn-hangzhou-b", "ecs.g6.large")
	if got.Verdict != preflightUnknown {
		t.Fatalf("verdict = %q, want unknown — an unprobed cloud must never read as checked", got.Verdict)
	}
	if !strings.Contains(got.Detail, "alibaba") {
		t.Errorf("the exclusion must name the cloud, got: %s", got.Detail)
	}
	if !strings.Contains(got.Detail, "UNVERIFIED") {
		t.Errorf("the exclusion must say the run was not verified, got: %s", got.Detail)
	}
}
