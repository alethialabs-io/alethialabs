// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 SOAK / day-2 window (BYOC A0.3) — the PURE, reusable half. Deliberately UNTAGGED
// (like controlplane.go / argocd_assert.go / t2_providers.go) so:
//
//   - `go mod tidy` sees its dependencies, and
//   - the parse / label-check / tfstate-count / verdict logic is unit-tested WITHOUT a
//     cloud, a token, or the e2e_t2 tag (t2_soak_pure_test.go).
//
// The soak proves the "keep proving it" day-2 loops against a REAL, already-provisioned
// cluster (Gap G12): a bounded liveness loop, a real DETECT_DRIFT job → honest posture, a
// 1Gi PVC → Bound → a CLOUD-SIDE sweep-tag hard-fail on the backing volume (the
// CSI-PVC-leak class, Gap G2), and an add-on health re-read. The orchestration that drives
// those against `*testing.T` + a live cluster lives in the e2e_t2-tagged t2_soak_run_test.go;
// nothing here imports `testing`.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// parseSoakDuration reads the soak window from a raw ALETHIA_E2E_SOAK value. An empty /
// unset value ⇒ DISABLED (ok=false, no error): the soak is opt-in and its absence leaves
// the base T2 proof unchanged. So are the explicit sentinels "off", "none" and "0", which
// exist because the workflow's `vars.E2E_SOAK || '10m'` means an unset variable is NOT
// unset by the time the harness sees it. A non-empty but unparseable or non-positive value
// is still a LOUD error — a workflow typo ("10 m", "0s", "0ms") must fail the run, never
// silently disable the day-2 proof.
func parseSoakDuration(raw string) (d time.Duration, enabled bool, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false, nil
	}
	// An EXPLICIT disable. Without this there is no way to turn the soak off from a repo variable:
	// e2e-nightly.yml resolves `vars.E2E_SOAK || '10m'`, so clearing the variable yields 10m again,
	// and setting it to "0" hit the non-positive error below and failed the run. The only working
	// disable was a literal single space, which nothing documented and nobody would guess. A leg that
	// wants its 25m of soak budget back — the fabric demo, say, which is already the widest term —
	// should be able to say so.
	switch strings.ToLower(raw) {
	case "off", "none", "0":
		return 0, false, nil
	}
	d, err = time.ParseDuration(raw)
	if err != nil {
		return 0, false, fmt.Errorf("ALETHIA_E2E_SOAK=%q is not a valid Go duration (e.g. 10m): %w", raw, err)
	}
	if d <= 0 {
		return 0, false, fmt.Errorf("ALETHIA_E2E_SOAK=%q must be a positive duration", raw)
	}
	return d, true, nil
}

// soakLivenessInterval picks a poll cadence for the tail liveness loop: 30s, but never more
// than a quarter of the window (so even a short soak polls a few times), and at least 2s.
func soakLivenessInterval(window time.Duration) time.Duration {
	iv := 30 * time.Second
	if q := window / 4; q < iv {
		iv = q
	}
	if iv < 2*time.Second {
		iv = 2 * time.Second
	}
	return iv
}

// tfstateResourceCount counts the managed resource INSTANCES recorded in an OpenTofu
// state document — the real evidence that a deploy wrote non-empty state, so a follow-on
// refresh-only drift run reconciling it (and reporting in-sync) is honest rather than a
// vacuous pass over an empty slot. An empty document or a parse failure is an error.
func tfstateResourceCount(state []byte) (int, error) {
	if len(strings.TrimSpace(string(state))) == 0 {
		return 0, errors.New("state document is empty")
	}
	var st struct {
		Resources []struct {
			Instances []json.RawMessage `json:"instances"`
		} `json:"resources"`
	}
	if err := json.Unmarshal(state, &st); err != nil {
		return 0, fmt.Errorf("parse tfstate: %w", err)
	}
	n := 0
	for _, r := range st.Resources {
		n += len(r.Instances)
	}
	return n, nil
}

// assertVolumeHasSweepTag HARD-FAILS unless a real cloud volume's labels carry this run's
// cluster sweep handle (`cluster=<name>`) — the CSI-PVC-leak-class guard (BYOC G2). An
// empty label map, a missing `cluster` key, or a wrong value all fail: a
// dynamically-provisioned `pvc-*` volume with no cluster label cannot be reclaimed by the
// label-scoped teardown sweep (scripts/e2e/hcloud-cleanup.sh) and leaks as a billable
// resource. This is the check A1.2 defers its EBS-CSI volume tagging to until it is green.
func assertVolumeHasSweepTag(labels map[string]string, cluster string) error {
	if strings.TrimSpace(cluster) == "" {
		return errors.New("cluster name is empty — cannot verify the volume sweep tag")
	}
	if len(labels) == 0 {
		return fmt.Errorf("cloud volume carries NO labels — sweep tag cluster=%s is missing; a pvc-* volume without it cannot be reclaimed by the cluster-scoped teardown and leaks (billable)", cluster)
	}
	got, ok := labels["cluster"]
	if !ok {
		return fmt.Errorf("cloud volume labels %v carry no 'cluster' key — sweep tag cluster=%s missing; the volume would leak", labels, cluster)
	}
	if got != cluster {
		return fmt.Errorf("cloud volume 'cluster' label = %q, want %q — sweep tag mismatch; the volume would not be reclaimed by this run's teardown", got, cluster)
	}
	return nil
}

// hcloudVolume is the subset of the Hetzner Cloud API volume object the soak reads.
type hcloudVolume struct {
	ID     int64             `json:"id"`
	Name   string            `json:"name"`
	Size   int               `json:"size"`
	Labels map[string]string `json:"labels"`
}

// parseHcloudVolumeResponse decodes a `GET /v1/volumes/{id}` body into a volume. Split out
// from the HTTP call so it is unit-testable without a network.
func parseHcloudVolumeResponse(body []byte) (*hcloudVolume, error) {
	var out struct {
		Volume hcloudVolume `json:"volume"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode hcloud volume: %w", err)
	}
	return &out.Volume, nil
}

// hcloudGetVolume fetches one volume by numeric id from the Hetzner Cloud API using the
// ambient HCLOUD_TOKEN as a bearer credential. The token is NEVER logged or returned — only
// placed in the Authorization header — per the A0.0 secret-hygiene invariant. A non-200
// (incl. 404 for a volume that never got the sweep label / doesn't exist) is an error, so
// the cloud-side check can never silently no-op.
func hcloudGetVolume(ctx context.Context, token, volumeID string) (*hcloudVolume, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, errors.New("HCLOUD_TOKEN is empty — cannot query the volume's cloud-side labels")
	}
	if strings.TrimSpace(volumeID) == "" {
		return nil, errors.New("volume id is empty — no backing volume to query")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.hetzner.cloud/v1/volumes/"+strings.TrimSpace(volumeID), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		// Deliberately do NOT echo the body (defense in depth — keep the surface minimal).
		return nil, fmt.Errorf("hcloud GET volume %s returned status %d", volumeID, resp.StatusCode)
	}
	return parseHcloudVolumeResponse(body)
}

// SoakDriftResource is one resource the drift posture counted as drifted, as recorded in
// the committed soak summary. It mirrors drift.ResourceDrift's public shape; it is declared
// here rather than imported so the e2e module keeps no dependency on packages/core just to
// name three strings.
type SoakDriftResource struct {
	Address string `json:"address"`
	Kind    string `json:"kind"`
	// Attributes are the leaf paths that differed, sorted. EMPTY IS NOT "no attributes
	// differed" — the emitter omits them when the verdict was reached before the leaves
	// could be computed, so a reader must not take absence for a clean diff.
	Attributes []string `json:"attributes,omitempty"`
}

// SoakSummary is the machine-readable result of the day-2 soak window (BYOC A0.3), written
// to ALETHIA_E2E_SOAK_SUMMARY so the proof/verdict capture (A0.4) can fold a soak line into
// the per-provider step summary.
type SoakSummary struct {
	Enabled             bool   `json:"enabled"`
	Provider            string `json:"provider"`
	DurationSeconds     int    `json:"duration_seconds"`
	LivenessChecks      int    `json:"liveness_checks"`
	LivenessFailures    int    `json:"liveness_failures"`
	DriftJobStatus      string `json:"drift_job_status"`
	DriftInSync         bool   `json:"drift_in_sync"`
	DriftDrifted        int    `json:"drift_drifted"`
	DriftStateResources int    `json:"drift_state_resources"`
	DriftStateReads     int    `json:"drift_state_reads"`
	// DriftDetails names the resources the posture counted as drifted, and the leaf
	// paths that differed. Carried into the COMMITTED proof bundle, not only the job
	// log, because a run's log expires and the ledger row it justifies does not: the
	// 2026-08-24 hetzner/day2 FAIL named five resources with no attributes, and
	// answering "is this provider hydration or real drift?" needed a second cluster.
	//
	// Empty on an in-sync posture. Paths only, never values — the same boundary
	// drift.NormalizedResource.Attributes documents: plan-JSON attribute VALUES are
	// plaintext secrets, and this summary is committed to the repo.
	DriftDetails []SoakDriftResource `json:"drift_details,omitempty"`
	// DriftBaseline is the posture read at the START of the soak window, and DriftNew is what
	// appeared BETWEEN the two reads. The verdict gates on DriftNew being empty — see
	// soakDriftDelta for why the day-2 question is a delta and not an absolute.
	DriftBaseline []SoakDriftResource `json:"drift_baseline,omitempty"`
	DriftNew      []SoakDriftResource `json:"drift_new,omitempty"`
	PVCChecked    bool                `json:"pvc_checked"`
	PVCBound      bool                `json:"pvc_bound"`
	PVCVolumeID   string              `json:"pvc_volume_id"`
	PVCSweepTagOK bool                `json:"pvc_sweep_tag_ok"`
	AddonReReadOK bool                `json:"addon_reread_ok"`
	Verdict       string              `json:"verdict"`
}

// soakDriftDelta reports the drifted entries present at the END of the soak window that were not
// already present at its START.
//
// WHY DAY-2 IS A DELTA AND NOT AN ABSOLUTE (#2503).
//
// The soak used to gate on `DriftInSync`, which a clean apply cannot deliver — and, measured on
// run 32878498637, SHOULD not. That run's posture named five resources and, for the first time,
// the attributes behind them:
//
//	hcloud_firewall.this                     apply_to
//	hcloud_primary_ip.control_plane_ipv4[0]  assignee_id
//	hcloud_primary_ip.worker_ipv4[0]         assignee_id
//	talos_cluster_kubeconfig.this            (leaves not computable — wholly sensitive)
//	talos_machine_secrets.this               (leaves not computable — wholly sensitive)
//
// All three named attributes are declared FROM THE OTHER SIDE of their relationship:
// `servers.tf` sets `firewall_ids`, and the server attaches the primary IP. Neither
// `hcloud_firewall` nor `hcloud_primary_ip` declares them (`network.tf:94-140`). So the provider
// populates them on refresh and the posture reports a real difference between recorded state and
// live — honestly.
//
// THE NORMALIZER IS RIGHT TO REFUSE THEM, and this deliberately does not touch it.
// `assignee_id` is a SCALAR, and normalize.go excludes scalars from both tiers by construction
// because "security-relevant out-of-band flips are overwhelmingly scalars". `apply_to` moves
// `[] -> non-empty`, not `null -> non-empty`, so Tier 2 declines: an element appeared. Widening
// either rule to make this cell green would be widening a ceiling to clear a red, and would blind
// the drift feature to exactly the class it exists to catch.
//
// What was wrong was the QUESTION. Day-2 asks "did anything change under us while we watched",
// and a template whose relationships are declared from the far side starts every window with a
// non-empty, benign hydration baseline. Comparing against that baseline asserts the same thing the
// old gate meant to and can actually be satisfied — while a resource that genuinely drifts DURING
// the window still appears, because it is not in the baseline.
//
// Keyed on address AND attribute set, so the SAME resource drifting on a NEW attribute is new. An
// entry that DISAPPEARS is not reported: converging toward state is not a day-2 failure.
func soakDriftDelta(before, after []SoakDriftResource) []SoakDriftResource {
	// Keyed on the (address, ATTRIBUTE) pair, not on the attribute SET.
	//
	// The set key was one character from correct and wrong in a way the comment above did not
	// cover. "An entry that DISAPPEARS is not reported" held for a resource that converged
	// ENTIRELY, but a resource that converged PARTIALLY produced a different set, hence a different
	// key, hence a miss — and was reported as new drift:
	//
	//	baseline [{X,[a,b]}]  final [{X,[a]}]   -> NEW [{X,[a]}]   'b' settled, and X is blamed
	//	baseline [{X,[a,b]}]  final []          -> NEW []          fully converged, forgiven
	//
	// Full convergence forgiven and partial convergence punished is not a distinction anyone would
	// defend on purpose, and it would surface as an intermittent day-2 red whose attribute list is
	// SHORTER than the baseline's — a confusing thing to debug from a verdict line. Eventual
	// consistency is the normal reason a set shrinks mid-window.
	//
	// Per-attribute keying keeps every property the set key was chosen for: a NEW attribute on an
	// already-drifting resource is still new (the firewall that begins hydrated on `apply_to` and
	// later has its RULES changed out-of-band is the case this must catch), an attribute that
	// settles is simply absent from `after`, and a wholly new resource has all-new pairs.
	//
	// The reported entry carries only the attributes that are actually NEW, so the verdict line
	// names what changed during the window rather than everything that resource ever drifted on.
	const noAttrs = "\x00none-recorded"
	// A resource whose leaves were not computable has no pairs to key on, so it keys on its address
	// alone via this sentinel — otherwise talos_cluster_kubeconfig and talos_machine_secrets, which
	// are ALWAYS in that state, would be invisible to the delta in both directions.
	attrsOf := func(r SoakDriftResource) []string {
		if len(r.Attributes) == 0 {
			return []string{noAttrs}
		}
		return r.Attributes
	}
	seen := make(map[string]struct{}, len(before))
	for _, r := range before {
		for _, a := range attrsOf(r) {
			seen[r.Address+"\x00"+a] = struct{}{}
		}
	}
	var out []SoakDriftResource
	for _, r := range after {
		var fresh []string
		for _, a := range attrsOf(r) {
			if _, ok := seen[r.Address+"\x00"+a]; !ok {
				fresh = append(fresh, a)
			}
		}
		if len(fresh) == 0 {
			continue
		}
		n := r
		if len(r.Attributes) > 0 {
			n.Attributes = fresh
		}
		out = append(out, n)
	}
	return out
}

// soakVerdictPass reports whether every soak check that RAN passed non-vacuously. The PVC
// cloud-side sweep-tag check is provider-specific (hetzner today), so when it was not
// exercised (PVCChecked=false) it does not gate the verdict — but when it ran it MUST pass.
func soakVerdictPass(s SoakSummary) bool {
	if !s.Enabled {
		return false
	}
	base := s.LivenessChecks > 0 && s.LivenessFailures == 0 &&
		s.DriftJobStatus == "SUCCESS" && len(s.DriftNew) == 0 && s.DriftStateReads > 0 &&
		s.DriftStateResources > 0 && s.AddonReReadOK
	if !base {
		return false
	}
	if s.PVCChecked {
		return s.PVCBound && s.PVCSweepTagOK
	}
	return true
}

// soakSummaryVerdict renders the one-line human verdict embedded in SoakSummary.Verdict and
// surfaced in the A0.4 proof/step-summary.
func soakSummaryVerdict(s SoakSummary) string {
	if !s.Enabled {
		return "soak: skipped (ALETHIA_E2E_SOAK unset)"
	}
	icon := "✅"
	if !soakVerdictPass(s) {
		icon = "❌"
	}
	pvc := "pvc: n/a (provider cloud-side check not wired)"
	if s.PVCChecked {
		pvc = fmt.Sprintf("pvc bound=%t sweep-tag=%t (vol %s)", s.PVCBound, s.PVCSweepTagOK, s.PVCVolumeID)
	}
	// `new=N` is what the verdict now turns on, and it is printed next to the baseline it is
	// measured against — "drifted=5 new=0" and "drifted=5 new=5" are opposite outcomes, and a
	// line showing only the absolute would render them identically.
	return fmt.Sprintf("%s soak %ds: liveness %d/%d ok · drift %s baseline=%d final=%d NEW=%d (state=%d res, non-empty reads=%d) · %s · addons re-read=%t",
		icon, s.DurationSeconds, s.LivenessChecks-s.LivenessFailures, s.LivenessChecks,
		s.DriftJobStatus, len(s.DriftBaseline), len(s.DriftDetails), len(s.DriftNew),
		s.DriftStateResources, s.DriftStateReads,
		pvc, s.AddonReReadOK)
}

// writeSoakSummary persists the soak summary as indented JSON (contains only counts +
// booleans + a numeric volume id — no secrets).
func writeSoakSummary(path string, s SoakSummary) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
