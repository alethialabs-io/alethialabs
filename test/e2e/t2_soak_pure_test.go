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
	// The #2503 direction, asserted where the old gate lived: an out-of-sync ABSOLUTE posture with
	// nothing new in the window is a PASS. Without this the old assertion could be restored without
	// anything going red.
	hydrated := green
	hydrated.DriftInSync = false
	hydrated.DriftBaseline = []SoakDriftResource{{Address: "hcloud_firewall.this", Attributes: []string{"apply_to"}}}
	hydrated.DriftDetails = hydrated.DriftBaseline
	if !soakVerdictPass(hydrated) {
		t.Fatal("a hydration baseline with nothing NEW must pass — in_sync is no longer the gate (#2503)")
	}
	// Each individual failing condition must flip the verdict red.
	flips := map[string]func(*SoakSummary){
		"disabled":           func(s *SoakSummary) { s.Enabled = false },
		"no liveness checks": func(s *SoakSummary) { s.LivenessChecks = 0 },
		"a liveness failure": func(s *SoakSummary) { s.LivenessFailures = 1 },
		"drift not success":  func(s *SoakSummary) { s.DriftJobStatus = "FAILED" },
		// #2503: the gate moved from the ABSOLUTE posture to the DELTA. `DriftInSync=false` is
		// the normal state of a freshly-applied template (the provider hydrates attributes the
		// config declares from the other side) and no longer fails; a resource that drifts
		// DURING the window does.
		"new drift in the window": func(s *SoakSummary) {
			s.DriftNew = []SoakDriftResource{{Address: "hcloud_server.worker[0]", Attributes: []string{"labels"}}}
		},
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

// TestSoakDriftDelta pins the #2503 fix: day-2 asks what changed DURING the window, not whether a
// freshly-applied template has a hydration baseline.
//
// The fixtures are the real posture from run 32878498637 — the first run whose failure named the
// attributes behind it. All three named attributes are declared from the OTHER side of their
// relationship (servers.tf sets firewall_ids; the server attaches the primary IP), so the provider
// populates them on refresh and the posture reports them honestly. normalize.go is right to refuse
// to dismiss them and is deliberately untouched.
func TestSoakDriftDelta(t *testing.T) {
	baseline := []SoakDriftResource{
		{Address: "hcloud_firewall.this", Kind: "modified", Attributes: []string{"apply_to"}},
		{Address: "hcloud_primary_ip.control_plane_ipv4[0]", Kind: "modified", Attributes: []string{"assignee_id"}},
		{Address: "hcloud_primary_ip.worker_ipv4[0]", Kind: "modified", Attributes: []string{"assignee_id"}},
		{Address: "talos_cluster_kubeconfig.this", Kind: "modified"},
		{Address: "talos_machine_secrets.this", Kind: "modified"},
	}

	t.Run("THE REGRESSION: an unchanged hydration baseline is not day-2 drift", func(t *testing.T) {
		if got := soakDriftDelta(baseline, baseline); len(got) != 0 {
			t.Fatalf("a window in which nothing changed must yield no new drift, got %v", got)
		}
	})

	t.Run("a resource that drifts DURING the window is caught", func(t *testing.T) {
		final := append(append([]SoakDriftResource(nil), baseline...),
			SoakDriftResource{Address: "hcloud_server.worker[0]", Kind: "modified", Attributes: []string{"labels"}})
		got := soakDriftDelta(baseline, final)
		if len(got) != 1 || got[0].Address != "hcloud_server.worker[0]" {
			t.Fatalf("real drift during the window must be reported, got %v", got)
		}
	})

	t.Run("the SAME resource drifting on a NEW attribute is new", func(t *testing.T) {
		// Keyed on the (address, attribute) PAIR. Keying on address alone would let a firewall that
		// starts hydrated on `apply_to` and later has its RULES changed out-of-band pass silently
		// — the single most valuable thing this check could catch.
		final := []SoakDriftResource{
			{Address: "hcloud_firewall.this", Kind: "modified", Attributes: []string{"apply_to", "rule"}},
		}
		if got := soakDriftDelta(baseline, final); len(got) != 1 {
			t.Fatalf("a new attribute on an already-drifted resource must be reported, got %v", got)
		}
	})

	t.Run("PARTIAL convergence is not new drift either", func(t *testing.T) {
		// The set key made this a false positive: baseline [{X,[a,b]}] and final [{X,[a]}] are
		// different SETS, so the final entry missed and X was blamed for drift it was recovering
		// from. Full convergence was forgiven and partial convergence punished — and it would have
		// surfaced as an intermittent red whose attribute list is SHORTER than the baseline's.
		before := []SoakDriftResource{
			{Address: "hcloud_firewall.this", Kind: "modified", Attributes: []string{"apply_to", "rule"}},
		}
		after := []SoakDriftResource{
			{Address: "hcloud_firewall.this", Kind: "modified", Attributes: []string{"apply_to"}},
		}
		if got := soakDriftDelta(before, after); len(got) != 0 {
			t.Fatalf("an attribute that SETTLED must not be reported as new drift, got %v", got)
		}
	})

	t.Run("only the NEW attributes are reported, not the whole history", func(t *testing.T) {
		before := []SoakDriftResource{
			{Address: "hcloud_firewall.this", Kind: "modified", Attributes: []string{"apply_to"}},
		}
		after := []SoakDriftResource{
			{Address: "hcloud_firewall.this", Kind: "modified", Attributes: []string{"apply_to", "rule"}},
		}
		got := soakDriftDelta(before, after)
		if len(got) != 1 {
			t.Fatalf("a new attribute must be reported, got %v", got)
		}
		if len(got[0].Attributes) != 1 || got[0].Attributes[0] != "rule" {
			t.Errorf("the verdict must name what changed DURING the window, not everything the resource ever drifted on; got %v", got[0].Attributes)
		}
	})

	// talos_cluster_kubeconfig and talos_machine_secrets are ALWAYS `attrs: none recorded` — their
	// leaves are not computable — so they have no pairs to key on and would be invisible to the
	// delta in BOTH directions without a sentinel.
	t.Run("an attribute-less resource is tracked by address", func(t *testing.T) {
		none := []SoakDriftResource{{Address: "talos_machine_secrets.this", Kind: "modified"}}
		if got := soakDriftDelta(none, none); len(got) != 0 {
			t.Fatalf("an unchanged attribute-less resource is not new, got %v", got)
		}
		if got := soakDriftDelta(nil, none); len(got) != 1 {
			t.Fatalf("an attribute-less resource appearing DURING the window must be caught, got %v", got)
		}
	})

	t.Run("an entry that DISAPPEARS is not a failure", func(t *testing.T) {
		// Converging toward recorded state is not day-2 drift.
		if got := soakDriftDelta(baseline, baseline[:2]); len(got) != 0 {
			t.Fatalf("convergence must not be reported as drift, got %v", got)
		}
	})

	t.Run("an empty baseline still catches everything", func(t *testing.T) {
		// A cloud whose apply hydrates nothing must not get a weaker check by accident.
		if got := soakDriftDelta(nil, baseline); len(got) != len(baseline) {
			t.Fatalf("with no baseline every entry is new, got %d of %d", len(got), len(baseline))
		}
	})

	t.Run("attribute-less entries are matched, not collapsed", func(t *testing.T) {
		// The two talos resources carry no computable leaves. They must still be distinguishable
		// from each other — collapsing them would let one appear while the other vanished.
		final := []SoakDriftResource{
			{Address: "talos_machine_secrets.this", Kind: "modified"},
			{Address: "talos_something_new.this", Kind: "modified"},
		}
		got := soakDriftDelta(baseline, final)
		if len(got) != 1 || got[0].Address != "talos_something_new.this" {
			t.Fatalf("want only the genuinely new attribute-less entry, got %v", got)
		}
	})
}

// TestSoakVerdictGatesOnNewDriftNotAbsolute — the verdict must follow the delta. A summary
// carrying the real hetzner baseline and nothing new is a PASS; the same summary with one new
// entry is a FAIL. Without this, changing the gate could silently make the soak unfailable.
func TestSoakVerdictGatesOnNewDriftNotAbsolute(t *testing.T) {
	base := SoakSummary{
		Enabled: true, LivenessChecks: 3, LivenessFailures: 0,
		DriftJobStatus: "SUCCESS", DriftStateReads: 3, DriftStateResources: 27,
		AddonReReadOK: true,
		DriftBaseline: []SoakDriftResource{{Address: "hcloud_firewall.this", Attributes: []string{"apply_to"}}},
		DriftDetails:  []SoakDriftResource{{Address: "hcloud_firewall.this", Attributes: []string{"apply_to"}}},
	}
	if !soakVerdictPass(base) {
		t.Error("a hydration baseline with nothing new must PASS — this is the whole of #2503")
	}

	drifted := base
	drifted.DriftNew = []SoakDriftResource{{Address: "hcloud_server.worker[0]", Attributes: []string{"labels"}}}
	if soakVerdictPass(drifted) {
		t.Error("real drift during the window must FAIL — the gate is not vacuous")
	}

	// The non-vacuity guards must still bite: a drift job that did not really run cannot pass by
	// virtue of having produced no delta.
	for _, bad := range []func(s *SoakSummary){
		func(s *SoakSummary) { s.DriftJobStatus = "FAILED" },
		func(s *SoakSummary) { s.DriftStateReads = 0 },
		func(s *SoakSummary) { s.DriftStateResources = 0 },
	} {
		s := base
		bad(&s)
		if soakVerdictPass(s) {
			t.Errorf("a vacuous drift read must not pass: %+v", s)
		}
	}
}
