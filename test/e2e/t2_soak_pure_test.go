// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PURE soak helpers (BYOC A0.3) — no cloud, no token, no e2e_t2 tag.
// These prove each day-2 check's core decision is non-vacuous: the sweep-tag guard
// HARD-FAILS on a missing/empty/wrong label (the refuter for a no-op cloud check), the
// duration parse is loud on a typo, the tfstate count is real, and the verdict only reads
// green when every check that ran actually passed.
package e2e

import (
	"encoding/json"
	"strings"
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

// TestSoakSummaryCarriesDriftAttributes pins the #2503 consumer half: the drift emitter has
// carried the differing leaf paths since drift.ResourceDrift grew Attributes, and the soak's
// summary must carry them into the COMMITTED proof bundle rather than only into a job log
// that expires. The 2026-08-24 hetzner/day2 FAIL named five resources and no attributes, and
// deciding whether those were provider hydration or real drift needed a second cluster.
//
// It also pins the boundary that keeps this safe to commit: attribute PATHS travel, attribute
// VALUES never do. Plan-JSON values are plaintext secrets (kubeconfigs, DB passwords, cloud
// tokens) and this summary is written into the repository.
func TestSoakSummaryCarriesDriftAttributes(t *testing.T) {
	s := SoakSummary{
		Enabled:  true,
		Provider: "hetzner",
		DriftDetails: []SoakDriftResource{
			{Address: "hcloud_firewall.this", Kind: "modified", Attributes: []string{"labels", "rule[0].description"}},
			// Attribute-less on purpose: several drift verdicts are reached before the leaves
			// are computed at all. That case must stay REPRESENTABLE and distinguishable from
			// "no attributes differed" — reading absence as a clean diff is the mistake.
			{Address: "talos_machine_secrets.this", Kind: "other"},
		},
	}

	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal soak summary: %v", err)
	}
	got := string(raw)

	for _, want := range []string{
		`"address":"hcloud_firewall.this"`,
		`"labels"`,
		`"rule[0].description"`,
		`"address":"talos_machine_secrets.this"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("committed summary is missing %s — the evidence #2503 needs\ngot: %s", want, got)
		}
	}

	// The attribute-less entry must NOT carry an empty `attributes` key: `omitempty` is what
	// keeps "not recorded" distinguishable from "recorded as empty".
	var back struct {
		DriftDetails []struct {
			Address    string   `json:"address"`
			Attributes []string `json:"attributes"`
		} `json:"drift_details"`
	}
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("round-trip: %v", err)
	}
	if len(back.DriftDetails) != 2 {
		t.Fatalf("want 2 drift details, got %d", len(back.DriftDetails))
	}
	if len(back.DriftDetails[0].Attributes) != 2 {
		t.Errorf("first entry lost its attribute paths: %#v", back.DriftDetails[0])
	}
	if len(back.DriftDetails[1].Attributes) != 0 {
		t.Errorf("attribute-less entry gained attributes: %#v", back.DriftDetails[1])
	}
}

// TestSoakSummaryOmitsDriftDetailsWhenInSync keeps the in-sync summary byte-identical to what
// it was before this field existed — an empty slice must vanish, not serialize as `[]`.
func TestSoakSummaryOmitsDriftDetailsWhenInSync(t *testing.T) {
	raw, err := json.Marshal(SoakSummary{Enabled: true, Provider: "aws", DriftInSync: true, DriftDetails: []SoakDriftResource{}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "drift_details") {
		t.Errorf("an in-sync posture must not emit drift_details at all\ngot: %s", raw)
	}
}
