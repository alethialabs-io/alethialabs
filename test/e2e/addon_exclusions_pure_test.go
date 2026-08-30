// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof that the add-on exclusion list stays honest — no cloud, no build tag.
//
// The list narrows what the `addons` dimension asserts, so it is exactly the kind of thing that
// decays into a place to put inconvenient failures. These tests are the cost of having one.
package e2e

import (
	"os"
	"path/filepath"
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
	// DERIVED, not hardcoded. This test was written against "aws", where every remaining exclusion
	// applied — and then external-dns was measured Healthy+Synced on aws three times and aws came
	// off its Clouds list, which broke a test about the partition MECHANISM for a reason that had
	// nothing to do with the mechanism. Asking the entry which cloud it claims keeps this pinned to
	// the machinery instead of to one cloud's current facts.
	cloud := aCloudClaimedBy(t, "external-dns")
	asserted, withheld := PartitionExcludedAddOns(cloud, expected)
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
	for _, n := range []string{argocd.AddOnAppName("external-dns")} {
		if !contains(withheld, n) {
			t.Errorf("%q is in addOnExclusions but was not withheld", n)
		}
	}
	// A non-excluded add-on and the repo app-of-apps must still be asserted, or the exclusion
	// mechanism would be quietly withholding the whole surface. vault and velero are deliberately
	// in this half: both exclusions came off in the same pass — velero's when the catalog stopped
	// rendering an invalid BackupStorageLocation at defaults, vault's when the runner gained the
	// init/unseal bootstrap — and these are the lines that would notice either creeping back.
	for _, n := range []string{
		"apps",
		argocd.AddOnAppName("kyverno"),
		argocd.AddOnAppName("loki"),
		argocd.AddOnAppName("velero"),
		argocd.AddOnAppName("vault"),
	} {
		if !contains(asserted, n) {
			t.Errorf("%q carries no exclusion but was not asserted", n)
		}
	}
}

// TestStaleExclusionsOnlyFireOnHealthyAndSynced varies the OBSERVED STATE, which is the axis that
// decides the verdict — a test that only varied which add-on was withheld would pass against a
// check that fired on any state at all.
func TestStaleExclusionsOnlyFireOnHealthyAndSynced(t *testing.T) {
	// external-dns is the subject because it is the only exclusion left after vault's and velero's
	// came off. Nothing in this test depends on WHICH add-on it is — the axis under test is the
	// observed state — but it must be a really-withheld one, or every case would trivially report
	// "not stale" and the test would pass against a check that never fires at all.
	app := argocd.AddOnAppName("external-dns")
	withheld := []string{app}
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
			got := staleExclusions(map[string]argoAppState{app: tc.state}, "aws", withheld)
			if gotStale := len(got) > 0; gotStale != tc.wantStale {
				t.Errorf("health=%s sync=%s: stale=%v, want %v (%v)",
					tc.state.Health, tc.state.Sync, gotStale, tc.wantStale, got)
			}
		})
	}
	// An app absent from the cluster entirely is not evidence of anything.
	if got := staleExclusions(map[string]argoAppState{}, "aws", withheld); len(got) != 0 {
		t.Errorf("an absent Application was reported stale: %v", got)
	}
	// And the message must name the add-on, or a red run cannot be acted on.
	got := staleExclusions(map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}, "aws", withheld)
	if len(got) != 1 || !strings.Contains(got[0], app) {
		t.Errorf("stale entry %v does not name %q", got, app)
	}
}

// TestDescribeWithheldAddOnsIsNotVacuous — a green run must be able to show what it did not assert.
// The empty case has to read differently from the populated one, or "nothing withheld" and
// "withheld, undisclosed" look identical in the log.
func TestDescribeWithheldAddOnsIsNotVacuous(t *testing.T) {
	cloud := aCloudClaimedBy(t, "external-dns")
	empty := DescribeWithheldAddOns(cloud, nil)
	if !strings.Contains(empty, "no add-ons withheld") {
		t.Errorf("empty description = %q, want it to state plainly that nothing was withheld", empty)
	}
	app := argocd.AddOnAppName("external-dns")
	got := DescribeWithheldAddOns(cloud, []string{app})
	for _, want := range []string{app, string(NeedsUserConfig), "#2717", "CUSTOMER action"} {
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
	if err := AssertNoStaleAddOnExclusions(t.Context(), "/nonexistent/kubeconfig", "aws", nil); err != nil {
		t.Errorf("empty withheld set must be a no-op, got: %v", err)
	}
}

// TestExclusionCloudsAreRealFixtureClouds is the anti-typo check for the per-cloud dimension.
//
// `Clouds: []string{"hetzer"}` is a positive list, so a typo does not fail loudly — it silently
// narrows the exclusion to a cloud that never runs, and every real cloud starts asserting an
// add-on nobody decided to assert. Pinning each name against the generated fixture that must exist
// for that cloud to run at all is the cheapest thing that cannot be fooled by a plausible spelling.
func TestExclusionCloudsAreRealFixtureClouds(t *testing.T) {
	for id, e := range addOnExclusions {
		for _, cloud := range e.Clouds {
			path := filepath.Join("fixtures", "addon_catalog."+cloud+".json")
			if _, err := os.Stat(path); err != nil {
				t.Errorf("addOnExclusions[%q].Clouds names %q, which has no add-on fixture (%s): "+
					"a cloud that cannot be run cannot be excluded, and the other clouds now "+
					"assert this add-on. Typo?", id, cloud, path)
			}
		}
	}
}

// TestExternalDnsExclusionIsPerCloud pins the MEASURED fact that made the Clouds dimension
// necessary, on the axis that decides it — the CLOUD, not the add-on.
//
// Run 33124236998 (hetzner · `addons`, the first sweep after #3048 repointed the fixture at each
// cloud's native provider) reported `addon-external-dns: health=Healthy sync=Synced`. It reached
// the cluster and converged. Withholding it there would red that run for a STALE EXCLUSION, which
// is the ratchet firing on a true statement — so hetzner must ASSERT it.
//
// AWS JOINED IT on 2026-08-30, and the ratchet is what said so: runs 33262881462, 33277594471 and
// 33282358378 all reported Healthy+Synced, and 33282358378 FAILED for the stale exclusion alone
// after its convergence and its teardown both passed. On EKS the controller runs with a provider
// name and no explicit identity, and the AWS SDK default chain then finds the node role through
// IMDS — the knob really is unfilled, and aws is the one cloud where that does not matter. gcp and
// azure have no equivalent ambient credential; alibaba still carries provider=cloudflare.
//
// A test that only varied the add-on would pass against a global list and prove nothing.
func TestExternalDnsExclusionIsPerCloud(t *testing.T) {
	app := argocd.AddOnAppName("external-dns")
	expected := []string{app, argocd.AddOnAppName("kyverno")}

	// Each of these came off the exclusion by MEASUREMENT, and each is named with the run that took
	// it off, because "it works now" without a run id is the shape this whole file refuses.
	for _, m := range []struct{ cloud, runs string }{
		{"hetzner", "run 33124236998"},
		{"aws", "runs 33262881462, 33277594471 and 33282358378"},
	} {
		t.Run(m.cloud+" asserts it — measured Healthy+Synced on "+m.runs, func(t *testing.T) {
			asserted, withheld := PartitionExcludedAddOns(m.cloud, expected)
			if contains(withheld, app) {
				t.Errorf("%s is withheld on %s, where it was measured Healthy+Synced (%s) — "+
					"the stale-exclusion ratchet will red the next addons run", app, m.cloud, m.runs)
			}
			if !contains(asserted, app) {
				t.Errorf("%s is neither asserted nor withheld on %s", app, m.cloud)
			}
			// And the ratchet must NOT fire there: a cloud that asserts an add-on never withholds
			// it, so a Healthy+Synced reading is a pass, not a stale exclusion.
			observed := map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}
			if got := staleExclusions(observed, m.cloud, withheld); len(got) != 0 {
				t.Errorf("%s reported a stale exclusion for an add-on it asserts: %v", m.cloud, got)
			}
		})
	}

	for _, cloud := range []string{"gcp", "azure", "alibaba"} {
		t.Run(cloud+" still withholds it", func(t *testing.T) {
			_, withheld := PartitionExcludedAddOns(cloud, expected)
			if !contains(withheld, app) {
				t.Errorf("%s is asserted on %s, where its controller has no identity to assume and "+
					"the sweep has not run since #3048 — asserting it there bets a real run on an "+
					"unmeasured convergence", app, cloud)
			}
			// The ratchet must still fire on these clouds if it does start converging.
			observed := map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}
			if got := staleExclusions(observed, cloud, withheld); len(got) != 1 {
				t.Errorf("%s: a withheld add-on that reached Healthy+Synced was not reported "+
					"stale (got %v) — the exclusion could then never come off", cloud, got)
			}
		})
	}
}

// TestUnscopedExclusionsApplyToEveryCloud — an EMPTY Clouds list must keep meaning "everywhere".
// If it ever came to mean "nowhere", every unscoped exclusion would silently stop being withheld
// and every cloud would start asserting a chart nobody decided to assert.
//
// It tests `appliesTo` directly rather than through the map, because as of vault's and velero's
// removal there is no unscoped ENTRY left to test through. A test that quietly became vacuous when
// its only subject was deleted is the "found nothing / nothing is wrong" shape this repo keeps
// paying for — so the property is pinned on the predicate, which cannot be emptied out from under
// it, and the map's own scoping stays covered by TestExternalDnsExclusionIsPerCloud.
func TestUnscopedExclusionsApplyToEveryCloud(t *testing.T) {
	unscoped := AddOnExclusion{Kind: NeedsUserConfig, Why: "a synthetic entry", Issue: "#2717"}
	scoped := AddOnExclusion{Kind: NeedsUserConfig, Why: "a synthetic entry", Issue: "#2717", Clouds: []string{"aws"}}
	for _, cloud := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		if !unscoped.appliesTo(cloud) {
			t.Errorf("an exclusion naming no clouds does not apply to %s, but an empty list means "+
				"every cloud", cloud)
		}
	}
	// And the other direction, or the test would pass against an appliesTo that returned true
	// unconditionally — which would make every exclusion global and the Clouds field decorative.
	if !scoped.appliesTo("aws") {
		t.Error("an exclusion naming aws does not apply to aws")
	}
	for _, cloud := range []string{"gcp", "hetzner"} {
		if scoped.appliesTo(cloud) {
			t.Errorf("an exclusion naming only aws also applies to %s", cloud)
		}
	}
}

// aCloudClaimedBy returns a cloud the named exclusion actually applies to, so a test about the
// exclusion MACHINERY does not fail when one cloud legitimately leaves an entry's list.
//
// It fails loudly on an entry that claims no cloud: an exclusion nothing applies to is not a
// fixture, it is a dead entry, and silently skipping would let this test pass while checking
// nothing.
func aCloudClaimedBy(t *testing.T, addOn string) string {
	t.Helper()
	e, ok := addOnExclusions[addOn]
	if !ok {
		t.Fatalf("no exclusion for %q — this test needs one to exercise the partition", addOn)
	}
	if len(e.Clouds) == 0 {
		t.Fatalf("the %q exclusion claims no cloud, so nothing it says can be exercised", addOn)
	}
	return e.Clouds[0]
}
