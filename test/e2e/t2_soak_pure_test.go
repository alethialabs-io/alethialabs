// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PURE soak helpers (BYOC A0.3) — no cloud, no token, no e2e_t2 tag.
// These prove each day-2 check's core decision is non-vacuous: the sweep-tag guard
// HARD-FAILS on a missing/empty/wrong label (the refuter for a no-op cloud check), the
// duration parse is loud on a typo, the tfstate count is real, and the verdict only reads
// green when every check that ran actually passed.
package e2e

import (
	"testing"
	"time"
)

func TestParseSoakDuration(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantOK  bool
		wantErr bool
		wantDur time.Duration
	}{
		{"unset disables", "", false, false, 0},
		{"blank disables", "   ", false, false, 0},
		{"valid 10m", "10m", true, false, 10 * time.Minute},
		{"valid 30s", "30s", true, false, 30 * time.Second},
		{"typo is loud", "10 m", false, true, 0},
		{"garbage is loud", "soon", false, true, 0},
		{"zero rejected", "0s", false, true, 0},
		{"negative rejected", "-5m", false, true, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, ok, err := parseSoakDuration(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err=%v, wantErr=%t", err, tt.wantErr)
			}
			if ok != tt.wantOK {
				t.Fatalf("enabled=%t, want %t", ok, tt.wantOK)
			}
			if !tt.wantErr && ok && d != tt.wantDur {
				t.Fatalf("dur=%v, want %v", d, tt.wantDur)
			}
		})
	}
}

func TestAssertVolumeHasSweepTag(t *testing.T) {
	const cluster = "alethia-nl-12345-1"
	// Positive: the exact sweep tag present (alongside other labels).
	if err := assertVolumeHasSweepTag(map[string]string{
		"cluster":                "alethia-nl-12345-1",
		"alethia_environment-id": "e2e-abc",
	}, cluster); err != nil {
		t.Fatalf("expected pass with the sweep tag present, got: %v", err)
	}
	// Refuters — each MUST hard-fail (this is the anti-no-op guard for the cloud check).
	refuters := []struct {
		name   string
		labels map[string]string
	}{
		{"nil labels (unlabelled leaked volume)", nil},
		{"empty labels", map[string]string{}},
		{"no cluster key", map[string]string{"foo": "bar"}},
		{"wrong cluster value", map[string]string{"cluster": "some-other-cluster"}},
		{"empty cluster value", map[string]string{"cluster": ""}},
	}
	for _, r := range refuters {
		t.Run(r.name, func(t *testing.T) {
			if err := assertVolumeHasSweepTag(r.labels, cluster); err == nil {
				t.Fatalf("expected a HARD FAIL for %q, got nil — the cloud-side check would be vacuous", r.name)
			}
		})
	}
	// An empty target cluster is itself a hard fail (can't verify anything).
	if err := assertVolumeHasSweepTag(map[string]string{"cluster": "x"}, ""); err == nil {
		t.Fatal("expected a hard fail when the target cluster name is empty")
	}
}

func TestTfstateResourceCount(t *testing.T) {
	if _, err := tfstateResourceCount(nil); err == nil {
		t.Fatal("expected an error for empty state (a vacuous drift floor)")
	}
	if _, err := tfstateResourceCount([]byte("   ")); err == nil {
		t.Fatal("expected an error for blank state")
	}
	if _, err := tfstateResourceCount([]byte("{not json")); err == nil {
		t.Fatal("expected a parse error for malformed state")
	}
	// A realistic minimal tofu state: 3 resources, one with 2 instances → 4 instances.
	state := []byte(`{
      "version": 4,
      "resources": [
        {"type": "hcloud_server", "instances": [{"attributes": {}}, {"attributes": {}}]},
        {"type": "hcloud_network", "instances": [{"attributes": {}}]},
        {"type": "hcloud_firewall", "instances": [{"attributes": {}}]}
      ]
    }`)
	n, err := tfstateResourceCount(state)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 4 {
		t.Fatalf("resource instance count = %d, want 4", n)
	}
	// A state with zero resources parses but counts 0 (caller treats 0 as vacuous).
	empty := []byte(`{"version": 4, "resources": []}`)
	if n, err := tfstateResourceCount(empty); err != nil || n != 0 {
		t.Fatalf("empty-resources state: n=%d err=%v, want 0,nil", n, err)
	}
}

func TestParseHcloudVolumeResponse(t *testing.T) {
	body := []byte(`{"volume": {"id": 12345, "name": "pvc-abc", "size": 10, "labels": {"cluster": "alethia-nl-9-1"}}}`)
	v, err := parseHcloudVolumeResponse(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v.ID != 12345 || v.Name != "pvc-abc" {
		t.Fatalf("parsed volume = %+v", v)
	}
	if v.Labels["cluster"] != "alethia-nl-9-1" {
		t.Fatalf("cluster label = %q", v.Labels["cluster"])
	}
	if _, err := parseHcloudVolumeResponse([]byte("{bad")); err == nil {
		t.Fatal("expected a decode error for malformed body")
	}
}

func TestSoakVerdictPass(t *testing.T) {
	green := SoakSummary{
		Enabled: true, LivenessChecks: 5, LivenessFailures: 0,
		DriftJobStatus: "SUCCESS", DriftInSync: true, DriftStateReads: 2, DriftStateResources: 15,
		PVCChecked: true, PVCBound: true, PVCSweepTagOK: true, AddonReReadOK: true,
	}
	if !soakVerdictPass(green) {
		t.Fatal("fully-green summary should pass")
	}
	// Each individual failing condition must flip the verdict red.
	flips := map[string]func(*SoakSummary){
		"disabled":            func(s *SoakSummary) { s.Enabled = false },
		"no liveness checks":  func(s *SoakSummary) { s.LivenessChecks = 0 },
		"a liveness failure":  func(s *SoakSummary) { s.LivenessFailures = 1 },
		"drift not success":   func(s *SoakSummary) { s.DriftJobStatus = "FAILED" },
		"drift not in sync":   func(s *SoakSummary) { s.DriftInSync = false },
		"no non-empty reads":  func(s *SoakSummary) { s.DriftStateReads = 0 },
		"no state resources":  func(s *SoakSummary) { s.DriftStateResources = 0 },
		"pvc not bound":       func(s *SoakSummary) { s.PVCBound = false },
		"pvc sweep tag fails": func(s *SoakSummary) { s.PVCSweepTagOK = false },
		"addon re-read fails": func(s *SoakSummary) { s.AddonReReadOK = false },
	}
	for name, mut := range flips {
		t.Run(name, func(t *testing.T) {
			s := green
			mut(&s)
			if soakVerdictPass(s) {
				t.Fatalf("%q should make the verdict fail", name)
			}
		})
	}
	// When the PVC check did NOT run (non-hetzner), it does not gate the verdict.
	noPVC := green
	noPVC.PVCChecked = false
	noPVC.PVCBound = false
	noPVC.PVCSweepTagOK = false
	if !soakVerdictPass(noPVC) {
		t.Fatal("with PVCChecked=false the PVC fields must not gate the verdict")
	}
}
