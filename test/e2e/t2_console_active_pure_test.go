// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Untagged unit proof for the PURE A0.5 helpers (BYOC A0.5): the flag gating, the
// snapshot-fidelity comparator (the finding-#4 guard), and the real-snapshot builder — exercised
// WITHOUT a cloud, a DB, a token, or the e2e_t2 tag, so `go test ./...` keeps them honest. The
// fidelity comparator is the load-bearing anti-divergence check, so it gets the refuters: an
// identical snapshot is clean, a drifted add-on value is caught, a synthetic key is caught, and the
// per-run dynamic inputs are correctly ignored.
package e2e

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestA05Truthy(t *testing.T) {
	for _, on := range []string{"1", "true", "TRUE", "Yes", " on "} {
		if !a05Truthy(on) {
			t.Errorf("a05Truthy(%q) = false, want true", on)
		}
	}
	for _, off := range []string{"", "0", "false", "no", "off", "nope"} {
		if a05Truthy(off) {
			t.Errorf("a05Truthy(%q) = true, want false", off)
		}
	}
}

// canonicalFixture mirrors the committed console fixture's fidelity-relevant keys.
func canonicalFixture(t *testing.T) map[string]any {
	t.Helper()
	raw := `{
		"provider": "hetzner",
		"region": "nbg1",
		"project_name": "alethia-fixture",
		"environment_stage": "fixture",
		"cluster": {"node_desired_size": 1, "instance_types": []},
		"addons": [{"id":"reloader","mode":"managed","chart":"reloader","version":"1.1.0","namespace":"reloader","values":{},"syncWave":1,"chartRepo":"https://stakater.github.io/stakater-charts"}]
	}`
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return m
}

func TestA05SnapshotFidelity_LeanSubsetIsFaithful(t *testing.T) {
	fixture := canonicalFixture(t)
	// The lean synthetic snapshot the harness seeds by default: only a subset of keys, and its
	// non-dynamic keys (provider, addons) MUST match the console shape. Its addons is the SAME shape
	// seedAddOns emits (JSON round-tripped here to match the normalization the real path does).
	lean := map[string]any{
		"id":                "e2e-fixture",
		"project_name":      "alethia-run",     // dynamic — ignored
		"environment_stage": "run",             // dynamic — ignored
		"region":            "hel1",            // dynamic — ignored
		"provider":          "hetzner",         // static — must match
		"addons":            fixture["addons"], // static — must match
	}
	norm, err := a05NormalizeSnapshot(lean)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if diffs := a05SnapshotFidelity(norm, fixture); len(diffs) != 0 {
		t.Fatalf("expected no divergences for a faithful lean snapshot, got: %v", diffs)
	}
}

func TestA05SnapshotFidelity_CatchesDriftedAddon(t *testing.T) {
	fixture := canonicalFixture(t)
	// A stale add-on version (the catalog moved, the harness seed didn't) MUST be caught — the exact
	// class of synthetic drift finding #4 warned about.
	seeded := map[string]any{
		"provider": "hetzner",
		"addons": []any{map[string]any{
			"id": "reloader", "mode": "managed", "chart": "reloader",
			"version": "9.9.9", "namespace": "reloader", "values": map[string]any{},
			"syncWave": 1.0, "chartRepo": "https://stakater.github.io/stakater-charts",
		}},
	}
	diffs := a05SnapshotFidelity(seeded, fixture)
	if len(diffs) == 0 {
		t.Fatal("expected a divergence for a drifted add-on version, got none")
	}
}

func TestA05SnapshotFidelity_CatchesSyntheticKey(t *testing.T) {
	fixture := canonicalFixture(t)
	// A key the console would NEVER freeze (not in the fixture) is flagged.
	seeded := map[string]any{
		"provider":         "hetzner",
		"synthetic_secret": "leaked", // not a console key
	}
	diffs := a05SnapshotFidelity(seeded, fixture)
	if len(diffs) != 1 {
		t.Fatalf("expected exactly one divergence for a synthetic key, got %d: %v", len(diffs), diffs)
	}
}

func TestA05SnapshotFidelity_IgnoresDynamicInputs(t *testing.T) {
	fixture := canonicalFixture(t)
	// Differing identity/naming/region are RUN INPUTS, never fidelity failures.
	seeded := map[string]any{
		"id":                "different",
		"project_name":      "totally-different",
		"region":            "us-east",
		"environment_stage": "prod",
		"provider":          "hetzner",
	}
	if diffs := a05SnapshotFidelity(seeded, fixture); len(diffs) != 0 {
		t.Fatalf("dynamic inputs must be ignored, got: %v", diffs)
	}
}

func TestA05RealSnapshotFromFixture_OverridesDynamicKeepsShape(t *testing.T) {
	fixture := canonicalFixture(t)
	snap, err := a05RealSnapshotFromFixture(fixture, "proj", "envx", "hetzner", "fsn1", "env-uuid")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// Dynamic fields overridden to this run.
	if snap["id"] != "e2e-envx" || snap["project_name"] != "proj" ||
		snap["environment_stage"] != "envx" || snap["region"] != "fsn1" ||
		snap["provider"] != "hetzner" || snap["environment_id"] != "env-uuid" {
		t.Fatalf("dynamic overrides not applied: %v", snap)
	}
	// The frozen (cheap) cluster + add-on shape is preserved verbatim from the console fixture.
	if !reflect.DeepEqual(snap["cluster"], fixture["cluster"]) {
		t.Fatalf("cluster shape mutated: %v vs %v", snap["cluster"], fixture["cluster"])
	}
	if !reflect.DeepEqual(snap["addons"], fixture["addons"]) {
		t.Fatalf("addons shape mutated: %v vs %v", snap["addons"], fixture["addons"])
	}
	// It is a DEEP COPY — mutating the result must not touch the fixture.
	snap["provider"] = "aws"
	if fixture["provider"] != "hetzner" {
		t.Fatal("a05RealSnapshotFromFixture aliased the fixture instead of deep-copying")
	}
	// And it is key-for-key faithful to the fixture it derives from.
	if diffs := a05SnapshotFidelity(mustNorm(t, snap), fixture); len(diffs) != 0 {
		// provider now aws (we mutated above) → expect exactly the provider divergence, nothing else.
		if len(diffs) != 1 {
			t.Fatalf("unexpected divergences: %v", diffs)
		}
	}
}

func mustNorm(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	n, err := a05NormalizeSnapshot(m)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	return n
}
