// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func waveAddOn(id string, wave int, crds ...string) types.AddOnInstall {
	return types.AddOnInstall{
		ID:        id,
		Mode:      "managed",
		ChartRepo: "https://example.test/charts",
		Chart:     id,
		Version:   "1.0.0",
		Namespace: id,
		SyncWave:  wave,
		CRDs:      crds,
	}
}

// The whole point of the wave rail: an operator (wave 0) must be applied — and its CRD Established
// — before the CR that needs its schema (wave 1). ArgoCD sync-waves do NOT order separate top-level
// Applications, so the runner must group them itself, in ascending order.
func TestWaveGroups_AscendingOrder(t *testing.T) {
	addons := []types.AddOnInstall{
		waveAddOn("db-primary", 1),
		waveAddOn("cnpg-operator", 0, "clusters.postgresql.cnpg.io"),
		waveAddOn("cache-main", 1),
		waveAddOn("late", 5),
	}

	waves, byWave := waveGroups(addons)

	if len(waves) != 3 || waves[0] != 0 || waves[1] != 1 || waves[2] != 5 {
		t.Fatalf("waves must be ascending [0 1 5], got %v", waves)
	}
	if len(byWave[0]) != 1 || byWave[0][0].ID != "cnpg-operator" {
		t.Fatalf("wave 0 must hold only the operator, got %+v", byWave[0])
	}
	if len(byWave[1]) != 2 {
		t.Fatalf("wave 1 must hold the two CR/chart add-ons, got %+v", byWave[1])
	}
	// The operator carries the CRD the next wave blocks on.
	if len(byWave[0][0].CRDs) != 1 || byWave[0][0].CRDs[0] != "clusters.postgresql.cnpg.io" {
		t.Fatalf("operator must declare the CRD the CR wave needs, got %v", byWave[0][0].CRDs)
	}
}

// Manifest-source add-ons are kubectl-applied by ApplyManifestAddOns and have no Application, so
// they must never appear in a Helm-Application wave (there'd be no file to apply).
func TestWaveGroups_ExcludesManifestAndGitOps(t *testing.T) {
	manifest := waveAddOn("rabbitmq-operator", 0)
	manifest.Source = "manifest"

	gitops := waveAddOn("gitops-app", 1)
	gitops.Mode = "gitops" // written into the customer's repo, not applied here

	waves, byWave := waveGroups([]types.AddOnInstall{
		manifest,
		gitops,
		waveAddOn("cache-main", 1),
	})

	if len(waves) != 1 || waves[0] != 1 {
		t.Fatalf("only the managed helm add-on's wave should remain, got %v", waves)
	}
	if len(byWave[1]) != 1 || byWave[1][0].ID != "cache-main" {
		t.Fatalf("expected only cache-main in wave 1, got %+v", byWave[1])
	}
}

// The convergence wait must only report success when EVERY add-on is Healthy AND Synced —
// "Progressing" or "OutOfSync" is not converged. (Reading health the instant after apply is what
// persisted a perfectly-fine database as "Creating" forever.)
func TestAllHealthy(t *testing.T) {
	cases := []struct {
		name string
		in   map[string]AddOnHealth
		want bool
	}{
		{"empty is not converged", map[string]AddOnHealth{}, false},
		{"all healthy+synced", map[string]AddOnHealth{
			"addon-a": {Health: "Healthy", Sync: "Synced"},
			"addon-b": {Health: "Healthy", Sync: "Synced"},
		}, true},
		{"one still progressing", map[string]AddOnHealth{
			"addon-a": {Health: "Healthy", Sync: "Synced"},
			"addon-b": {Health: "Progressing", Sync: "Synced"},
		}, false},
		{"healthy but OutOfSync", map[string]AddOnHealth{
			"addon-a": {Health: "Healthy", Sync: "OutOfSync"},
		}, false},
		{"missing (the CR raced its operator)", map[string]AddOnHealth{
			"addon-a": {Health: "Missing", Sync: "Unknown"},
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := allHealthy(tc.in); got != tc.want {
				t.Fatalf("allHealthy = %v, want %v", got, tc.want)
			}
		})
	}
}

// The timeout message must name what did NOT converge (an operator report of "timed out" with no
// detail is useless for the console/operator).
func TestPending_NamesUnconverged(t *testing.T) {
	got := pending(map[string]AddOnHealth{
		"addon-ok":  {Health: "Healthy", Sync: "Synced"},
		"addon-bad": {Health: "Degraded", Sync: "OutOfSync"},
	})
	if got == "none" {
		t.Fatal("a degraded add-on must be listed as pending")
	}
	if want := "addon-bad(Degraded/OutOfSync)"; !contains(got, want) {
		t.Fatalf("pending must name the unconverged add-on + its status, got %q", got)
	}
	if contains(got, "addon-ok") {
		t.Fatalf("a converged add-on must not be listed, got %q", got)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
