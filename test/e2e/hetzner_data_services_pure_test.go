// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR read-back of the Hetzner in-cluster data-service seed — NO build tag, NO cloud.
//
// Hetzner's database/cache/queue are CarriedInCluster: the proof is an ArgoCD Application name, and
// the Application only exists if the DEPLOY SNAPSHOT carried the chart. Two artifacts therefore have
// to agree, across a language boundary:
//
//	the Go max-config surface   MaxConfigProjectConfig("hetzner").Databases/Caches/Queues
//	the generated TS fixture    test/e2e/fixtures/hetzner_data_services.json
//
// The TS half is guarded against ITS source by catalog-export's sibling test in vitest
// (hetzner-data-services-export.test.ts). This file guards the JOIN: that the fixture was generated
// from the same components the Go fixture seeds, and that the three cells' ArgoCD Application names
// are exactly the ones the seeded specs will produce. Without it, a rename on either side would ship
// a green PR and a red nightly a week later — the feedback loop this whole tier exists to shorten.
package e2e

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// TestHetznerDataServiceFixtureMatchesTheMaxConfigSurface compares the generated fixture's INPUT
// components with the real max-config ProjectConfig, field by field. Mismatched names would install
// a chart for a component the deploy never declared (and leave the declared one unbacked); a
// mismatched engine version would install a different Postgres than the snapshot claims.
func TestHetznerDataServiceFixtureMatchesTheMaxConfigSurface(t *testing.T) {
	fx, err := loadHetznerDataServiceFixture()
	if err != nil {
		t.Fatalf("load hetzner data-service fixture: %v", err)
	}
	pc := MaxConfigProjectConfig("hetzner")

	if len(fx.Components.Databases) != len(pc.Databases) {
		t.Fatalf("fixture declares %d database(s), the max-config surface seeds %d — every seeded database needs its own CNPG Cluster Application (%s)",
			len(fx.Components.Databases), len(pc.Databases), hetznerDataServicesRegenerate)
	}
	for i, want := range pc.Databases {
		got := fx.Components.Databases[i]
		if got.Name != want.Name {
			t.Errorf("database[%d]: fixture name %q, max-config seeds %q — the Application would be addon-db-%s while the snapshot declares %s (%s)",
				i, got.Name, want.Name, got.Name, want.Name, hetznerDataServicesRegenerate)
		}
		if got.EngineFamily != want.EngineFamily {
			t.Errorf("database[%d] %q: fixture engine_family %q, max-config seeds %q — the mapper only charts postgres, so a mismatch silently drops the database (%s)",
				i, want.Name, got.EngineFamily, want.EngineFamily, hetznerDataServicesRegenerate)
		}
		if got.EngineVersion != want.EngineVersion {
			t.Errorf("database[%d] %q: fixture engine_version %q, max-config seeds %q — the chart's imageName is built from it, so the run would prove a different Postgres than it declares (%s)",
				i, want.Name, got.EngineVersion, want.EngineVersion, hetznerDataServicesRegenerate)
		}
	}

	if len(fx.Components.Caches) != len(pc.Caches) {
		t.Fatalf("fixture declares %d cache(s), the max-config surface seeds %d (%s)",
			len(fx.Components.Caches), len(pc.Caches), hetznerDataServicesRegenerate)
	}
	for i, want := range pc.Caches {
		got := fx.Components.Caches[i]
		if got.Name != want.Name {
			t.Errorf("cache[%d]: fixture name %q, max-config seeds %q (%s)", i, got.Name, want.Name, hetznerDataServicesRegenerate)
		}
		wantNodes := 1
		if want.NumCacheNodes != nil {
			wantNodes = *want.NumCacheNodes
		}
		if got.NumCacheNodes != wantNodes {
			t.Errorf("cache[%d] %q: fixture num_cache_nodes %d, max-config seeds %d — the Valkey chart's replica count (and its MANDATORY replica persistence) derive from it (%s)",
				i, want.Name, got.NumCacheNodes, wantNodes, hetznerDataServicesRegenerate)
		}
	}

	if len(fx.Components.Queues) != len(pc.Queues) {
		t.Fatalf("fixture declares %d queue(s), the max-config surface seeds %d (%s)",
			len(fx.Components.Queues), len(pc.Queues), hetznerDataServicesRegenerate)
	}
	for i, want := range pc.Queues {
		if got := fx.Components.Queues[i]; got.Name != want.Name {
			t.Errorf("queue[%d]: fixture name %q, max-config seeds %q (%s)", i, got.Name, want.Name, hetznerDataServicesRegenerate)
		}
	}
}

// TestHetznerInClusterCellsAreCoveredBySeededSpecs is the assertion that makes D1's fix real: EVERY
// CarriedInCluster cell's ArgoApp must be an Application the seeded specs actually produce, under
// the runner's own naming rule (argocd.AddOnAppName). It is the exact question
// AssertMaxConfigKindsInState asks on a real run, asked for free on every PR — and it is the one
// nobody was asking, which is why three cells named Applications that could never exist.
func TestHetznerInClusterCellsAreCoveredBySeededSpecs(t *testing.T) {
	specs, err := HetznerDataServiceAddOns()
	if err != nil {
		t.Fatalf("load hetzner data-service add-ons: %v", err)
	}
	rendered := map[string]bool{}
	for _, s := range specs {
		rendered[argocd.AddOnAppName(s.ID)] = true
	}
	checked := 0
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell("hetzner")
		if !ok || cell.Carriage != CarriedInCluster {
			continue
		}
		checked++
		if !rendered[cell.ArgoApp] {
			t.Errorf("kind %q on hetzner asserts ArgoCD Application %q, but the seeded specs render only %v — "+
				"an in-cluster cell whose chart the deploy never carries is Missing on EVERY run, which is what this seed exists to fix (%s)",
				k.Kind, cell.ArgoApp, sortedKeys(rendered), hetznerDataServicesRegenerate) //nolint:gocritic // sortedKeys lives in argocd_assert_test.go
		}
	}
	if checked != 4 {
		t.Errorf("checked %d CarriedInCluster cells on hetzner, want 4 (database/cache/queue/registry) — the guard has drifted off the kinds it protects", checked)
	}
}

// TestMaxConfigSnapshotSeedsHetznerInClusterCharts drives the real snapshot path: a Hetzner
// max-config snapshot must carry the data-service specs in `addons` ALONGSIDE whatever the tier
// already seeded, and the other four clouds must be untouched.
func TestMaxConfigSnapshotSeedsHetznerInClusterCharts(t *testing.T) {
	lean := []any{map[string]any{"id": "reloader"}}

	t.Run("hetzner appends the synthesized charts", func(t *testing.T) {
		base := map[string]any{"id": "e2e-x", "project_name": "maxcfg", "provider": "hetzner", "addons": lean}
		if err := MaxConfigSnapshot(base, "hetzner"); err != nil {
			t.Fatalf("MaxConfigSnapshot(hetzner): %v", err)
		}
		addons, ok := base["addons"].([]any)
		if !ok {
			t.Fatalf("addons is %T, want a list", base["addons"])
		}
		ids := map[string]bool{}
		for _, a := range addons {
			m, isMap := a.(map[string]any)
			if !isMap {
				t.Fatalf("add-on entry is %T, want an object", a)
			}
			id, _ := m["id"].(string)
			ids[id] = true
		}
		// The tier's own seed must SURVIVE — an overwrite here would strip the ArgoCD health
		// assertion of the add-on it was given teeth with.
		if !ids["reloader"] {
			t.Error("the lean seed was dropped: max-config must APPEND the in-cluster charts, never replace `addons`")
		}
		for _, want := range []string{"cnpg-operator", "db-appdb", "cache-sessions", "queue-jobs"} {
			if !ids[want] {
				t.Errorf("hetzner max-config snapshot is missing in-cluster add-on %q — its kind can never converge", want)
			}
		}
	})

	// Cloud-parity: the data services are Hetzner's answer to kinds the other four carry in tofu.
	// Leaking them onto a managed cloud would install a CNPG cluster next to the RDS instance the
	// same run provisioned, and the ArgoCD gate would then wait on charts nothing asked for.
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		t.Run(provider+" is untouched", func(t *testing.T) {
			base := map[string]any{"id": "e2e-x", "project_name": "maxcfg", "provider": provider, "addons": lean}
			if err := MaxConfigSnapshot(base, provider); err != nil {
				t.Fatalf("MaxConfigSnapshot(%s): %v", provider, err)
			}
			addons, ok := base["addons"].([]any)
			if !ok {
				t.Fatalf("addons is %T, want a list", base["addons"])
			}
			if len(addons) != len(lean) {
				t.Errorf("%s seeded %d add-on(s), want the %d it started with — hetzner's in-cluster data services must not reach a managed cloud: %v",
					provider, len(addons), len(lean), addons)
			}
		})
	}
}
