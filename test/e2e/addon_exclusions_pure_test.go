// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof that the add-on exclusion list stays honest — no cloud, no build tag.
//
// The list narrows what the `addons` dimension asserts, so it is exactly the kind of thing that
// decays into a place to put inconvenient failures. These tests are the cost of having one.
package e2e

import (
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

var exclusionIssueRe = regexp.MustCompile(`^#\d+$`)

// TestAddOnExclusionsAreRealCatalogAddOns is the anti-inertness check.
//
// An exclusion keyed on an add-on the catalog does not have excludes NOTHING: the id never matches
// a rendered Application, so the entry sits there reading like a documented decision while the
// dimension goes on asserting the chart. A rename is all it takes. That failure is invisible in
// every other test, so it is pinned here.
func TestAddOnExclusionsAreRealCatalogAddOns(t *testing.T) {
	catalog, err := AllCatalogAddOns()
	if err != nil {
		t.Fatalf("catalog fixture unreadable, so no exclusion can be validated: %v", err)
	}
	known := make(map[string]struct{}, len(catalog))
	for _, a := range catalog {
		known[a.ID] = struct{}{}
	}
	for id := range addOnExclusions {
		if _, ok := known[id]; !ok {
			t.Errorf("addOnExclusions has an entry for %q, which is not in the add-on catalog — "+
				"it excludes nothing and the dimension still asserts every chart. Renamed, or a typo?", id)
		}
	}
}

// TestAddOnExclusionsAreLegible enforces the property that makes an exclusion reviewable:
// a reason a human can act on, and an issue so it cannot become permanent by being forgotten.
func TestAddOnExclusionsAreLegible(t *testing.T) {
	for id, e := range addOnExclusions {
		t.Run(id, func(t *testing.T) {
			if e.Kind != NeedsUserConfig {
				t.Errorf("kind %q is not a known AddOnExclusionKind — add the constant with its "+
					"own doc comment rather than inventing a string here", e.Kind)
			}
			// A one-word "why" is the shape a placeholder takes.
			if len(strings.TrimSpace(e.Why)) < 60 {
				t.Errorf("Why is %d chars; it must say what a CUSTOMER would have to supply, in "+
					"enough detail to re-decide the exclusion without re-deriving it", len(e.Why))
			}
			if !exclusionIssueRe.MatchString(e.Issue) {
				t.Errorf("Issue = %q, want a tracking issue like #2717 — an exclusion with no issue "+
					"becomes permanent by default", e.Issue)
			}
		})
	}
}

// TestPartitionExcludedAddOnsLosesNothing pins the property that matters most: partitioning is a
// SPLIT, not a filter. An add-on that fell out of both halves would be silently unasserted, which
// is the failure this whole mechanism is supposed to make impossible.
func TestPartitionExcludedAddOnsLosesNothing(t *testing.T) {
	expected := []string{
		"apps",
		argocd.AddOnAppName("vault"),
		argocd.AddOnAppName("kyverno"),
		argocd.AddOnAppName("velero"),
		argocd.AddOnAppName("loki"),
		argocd.AddOnAppName("external-dns"),
	}
	asserted, withheld := PartitionExcludedAddOns(expected)
	if got, want := len(asserted)+len(withheld), len(expected); got != want {
		t.Fatalf("partition returned %d names for %d inputs — the split dropped or duplicated one", got, want)
	}
	seen := map[string]int{}
	for _, n := range append(append([]string{}, asserted...), withheld...) {
		seen[n]++
	}
	for _, n := range expected {
		if seen[n] != 1 {
			t.Errorf("%q appears %d times across the two halves, want exactly 1", n, seen[n])
		}
	}
	for _, n := range []string{argocd.AddOnAppName("vault"), argocd.AddOnAppName("velero"), argocd.AddOnAppName("external-dns")} {
		if !contains(withheld, n) {
			t.Errorf("%q is in addOnExclusions but was not withheld", n)
		}
	}
	// A non-excluded add-on and the repo app-of-apps must still be asserted, or the exclusion
	// mechanism would be quietly withholding the whole surface.
	for _, n := range []string{"apps", argocd.AddOnAppName("kyverno"), argocd.AddOnAppName("loki")} {
		if !contains(asserted, n) {
			t.Errorf("%q carries no exclusion but was not asserted", n)
		}
	}
}

// TestStaleExclusionsOnlyFireOnHealthyAndSynced varies the OBSERVED STATE, which is the axis that
// decides the verdict — a test that only varied which add-on was withheld would pass against a
// check that fired on any state at all.
func TestStaleExclusionsOnlyFireOnHealthyAndSynced(t *testing.T) {
	vault := argocd.AddOnAppName("vault")
	withheld := []string{vault}
	cases := []struct {
		name      string
		state     argoAppState
		wantStale bool
	}{
		{"healthy and synced is the thing working", argoAppState{Health: "Healthy", Sync: "Synced"}, true},
		{"healthy but OutOfSync is the spurious-diff class", argoAppState{Health: "Healthy", Sync: "OutOfSync"}, false},
		{"progressing has not finished", argoAppState{Health: "Progressing", Sync: "Synced"}, false},
		{"degraded is the exclusion being right", argoAppState{Health: "Degraded", Sync: "Synced"}, false},
		{"missing says nothing either way", argoAppState{Health: "Missing", Sync: "OutOfSync"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := staleExclusions(map[string]argoAppState{vault: tc.state}, withheld)
			if gotStale := len(got) > 0; gotStale != tc.wantStale {
				t.Errorf("health=%s sync=%s: stale=%v, want %v (%v)",
					tc.state.Health, tc.state.Sync, gotStale, tc.wantStale, got)
			}
		})
	}
	// An app absent from the cluster entirely is not evidence of anything.
	if got := staleExclusions(map[string]argoAppState{}, withheld); len(got) != 0 {
		t.Errorf("an absent Application was reported stale: %v", got)
	}
	// And the message must name the add-on, or a red run cannot be acted on.
	got := staleExclusions(map[string]argoAppState{vault: {Health: "Healthy", Sync: "Synced"}}, withheld)
	if len(got) != 1 || !strings.Contains(got[0], vault) {
		t.Errorf("stale entry %v does not name %q", got, vault)
	}
}

// TestDescribeWithheldAddOnsIsNotVacuous — a green run must be able to show what it did not assert.
// The empty case has to read differently from the populated one, or "nothing withheld" and
// "withheld, undisclosed" look identical in the log.
func TestDescribeWithheldAddOnsIsNotVacuous(t *testing.T) {
	empty := DescribeWithheldAddOns(nil)
	if !strings.Contains(empty, "no add-ons withheld") {
		t.Errorf("empty description = %q, want it to state plainly that nothing was withheld", empty)
	}
	vault := argocd.AddOnAppName("vault")
	got := DescribeWithheldAddOns([]string{vault})
	for _, want := range []string{vault, string(NeedsUserConfig), "#2717", "SEALED"} {
		if !strings.Contains(got, want) {
			t.Errorf("description does not mention %q:\n%s", want, got)
		}
	}
	if got == empty {
		t.Error("a populated description is identical to the empty one")
	}
}

// TestNoWithheldAddOnsSkipsTheClusterRead pins the short-circuit. With nothing withheld the check
// must return before it ever reaches kubectl — otherwise every floor run (which withholds nothing)
// would pay for a cluster read to learn there was nothing to re-validate. Passing a deliberately
// unusable kubeconfig path proves it never got that far.
func TestNoWithheldAddOnsSkipsTheClusterRead(t *testing.T) {
	if err := AssertNoStaleAddOnExclusions(t.Context(), "/nonexistent/kubeconfig", nil); err != nil {
		t.Errorf("empty withheld set must be a no-op, got: %v", err)
	}
}
