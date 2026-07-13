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
// the base T2 proof unchanged. A non-empty but unparseable or non-positive value is a LOUD
// error — a workflow typo (e.g. "10 m", "0s") must fail the run, never silently disable the
// day-2 proof.
func parseSoakDuration(raw string) (d time.Duration, enabled bool, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
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
	PVCChecked          bool   `json:"pvc_checked"`
	PVCBound            bool   `json:"pvc_bound"`
	PVCVolumeID         string `json:"pvc_volume_id"`
	PVCSweepTagOK       bool   `json:"pvc_sweep_tag_ok"`
	AddonReReadOK       bool   `json:"addon_reread_ok"`
	Verdict             string `json:"verdict"`
}

// soakVerdictPass reports whether every soak check that RAN passed non-vacuously. The PVC
// cloud-side sweep-tag check is provider-specific (hetzner today), so when it was not
// exercised (PVCChecked=false) it does not gate the verdict — but when it ran it MUST pass.
func soakVerdictPass(s SoakSummary) bool {
	if !s.Enabled {
		return false
	}
	base := s.LivenessChecks > 0 && s.LivenessFailures == 0 &&
		s.DriftJobStatus == "SUCCESS" && s.DriftInSync && s.DriftStateReads > 0 &&
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
	return fmt.Sprintf("%s soak %ds: liveness %d/%d ok · drift %s in_sync=%t (state=%d res, non-empty reads=%d, drifted=%d) · %s · addons re-read=%t",
		icon, s.DurationSeconds, s.LivenessChecks-s.LivenessFailures, s.LivenessChecks,
		s.DriftJobStatus, s.DriftInSync, s.DriftStateResources, s.DriftStateReads, s.DriftDrifted,
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
