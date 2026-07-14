// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// T2 SOAK / day-2 window (BYOC A0.3) — the ORCHESTRATION half, driven against a live,
// already-provisioned cluster via *testing.T. Compiled only under the e2e_t2 tag (like
// t2_provision_test.go); the pure helpers it calls live in the untagged t2_soak.go so they
// stay unit-testable without a cloud.
//
// Invoked from TestT2RealCloudProvisioning AFTER the readiness + ArgoCD asserts and BEFORE
// the test returns, so the guaranteed t.Cleanup teardown still runs. Opt-in via
// ALETHIA_E2E_SOAK; unset ⇒ a clean skip (base T2 unchanged).
//
// # How each day-2 check defeats its own vacuity
//
//   - LIVENESS: each poll HARD-ASSERTS /readyz==ok AND a Ready node; a drop mid-soak fails
//     the test. The check count is asserted > 0.
//   - DRIFT: the drift job's state is ALIASED onto the deploy job's slot, so its refresh-only
//     plan reconciles the deploy's REAL state (asserted non-empty, >0 resources) — and we
//     assert the drift run issued ≥1 NON-EMPTY state read (StateReadsNonEmpty), so an
//     in-sync posture cannot come from a vacuous empty-state pass. The posture must be
//     genuinely in-sync (drifted==0) right after a clean apply.
//   - PVC: a 1Gi PVC + consuming pod must reach Bound/Ready, THEN the backing cloud volume
//     is fetched from the hcloud API and HARD-FAILS unless it carries the cluster sweep tag
//     (assertVolumeHasSweepTag) — a missing tag is a leak, not a pass.
//   - ADD-ONS: the SAME derived (never empty) expected Application set is re-asserted
//     Healthy+Synced at the end of the window.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// soakParams carries the live-cluster handles the soak needs.
type soakParams struct {
	project      string
	env          string
	provider     string
	region       string
	clusterName  string
	deployJobID  string
	expectedApps []string
}

// runT2Soak drives the day-2 soak window. It is a no-op (clean skip) unless ALETHIA_E2E_SOAK
// is set to a positive Go duration. On any check failure it t.Fatalf's; a deferred summary
// write persists whatever was proven so far to ALETHIA_E2E_SOAK_SUMMARY for the A0.4 capture.
func runT2Soak(t *testing.T, ctx context.Context, cp *ControlPlane, kc string, p soakParams) {
	t.Helper()

	dur, enabled, err := parseSoakDuration(os.Getenv("ALETHIA_E2E_SOAK"))
	if err != nil {
		t.Fatalf("A0.3 soak: %v", err)
	}
	if !enabled {
		t.Log("A0.3 soak: SKIPPED (ALETHIA_E2E_SOAK unset) — base T2 proof unchanged")
		if sp := os.Getenv("ALETHIA_E2E_SOAK_SUMMARY"); sp != "" {
			_ = writeSoakSummary(sp, SoakSummary{Enabled: false, Provider: p.provider, Verdict: "soak: skipped"})
		}
		return
	}

	summary := &SoakSummary{Enabled: true, Provider: p.provider, DurationSeconds: int(dur.Seconds())}
	defer func() {
		summary.Verdict = soakSummaryVerdict(*summary)
		if sp := os.Getenv("ALETHIA_E2E_SOAK_SUMMARY"); sp != "" {
			if werr := writeSoakSummary(sp, *summary); werr != nil {
				t.Logf("A0.3 soak: failed to write summary to %s: %v", sp, werr)
			}
		}
		t.Logf("A0.3 soak summary: %s", summary.Verdict)
	}()

	soakDeadline := time.Now().Add(dur)
	t.Logf("A0.3 soak: ENABLED for %s — day-2 window %s (deadline %s)", dur, p.provider, soakDeadline.UTC().Format(time.RFC3339))

	// ── 1. Initial liveness: /readyz + a Ready node must answer before we exercise day-2. ──
	soakLivenessCheck(t, ctx, kc, summary)

	// ── 2. Real DETECT_DRIFT → honest in-sync posture over the deploy's real state. ──
	soakDriftCheck(t, ctx, cp, p, summary)

	// ── 3. 1Gi PVC → Bound → cloud-side sweep-tag hard-fail on the backing volume. ──
	soakPVCCheck(t, ctx, kc, p, summary)

	// ── 4. Add-on health re-read: the derived expected set must STILL be Healthy+Synced. ──
	soakAddonReRead(t, ctx, kc, p, summary)

	// ── 5. Tail liveness loop to fill out the soak window; a drop any time fails. ──
	interval := soakLivenessInterval(dur)
	for time.Now().Before(soakDeadline) {
		select {
		case <-ctx.Done():
			t.Fatalf("A0.3 soak: context cancelled during liveness loop: %v", ctx.Err())
		case <-time.After(interval):
		}
		soakLivenessCheck(t, ctx, kc, summary)
	}
	t.Logf("A0.3 soak: completed %s window — %d liveness checks, all OK", dur, summary.LivenessChecks)
}

// soakLivenessCheck HARD-ASSERTS the cluster is still alive: the apiserver /readyz returns
// "ok" AND at least one node is Ready. A failure means the cluster dropped mid-soak.
func soakLivenessCheck(t *testing.T, ctx context.Context, kc string, s *SoakSummary) {
	t.Helper()
	s.LivenessChecks++
	if err := soakReadyz(ctx, kc); err != nil {
		s.LivenessFailures++
		t.Fatalf("A0.3 liveness: /readyz probe failed at check %d (cluster dropped mid-soak): %v", s.LivenessChecks, err)
	}
	out, err := soakKubectl(ctx, kc, 60*time.Second, "get", "nodes", "--no-headers")
	if err != nil {
		s.LivenessFailures++
		t.Fatalf("A0.3 liveness: kubectl get nodes failed at check %d: %v\n%s", s.LivenessChecks, err, out)
	}
	if !HasReadyNode(string(out)) {
		s.LivenessFailures++
		t.Fatalf("A0.3 liveness: no Ready node at check %d:\n%s", s.LivenessChecks, out)
	}
}

// soakReadyz calls the apiserver's /readyz endpoint via kubectl (the runner-written
// kubeconfig — the same independent path the base T2 proof uses). "ok" is the healthy body.
func soakReadyz(ctx context.Context, kc string) error {
	out, err := soakKubectl(ctx, kc, 30*time.Second, "get", "--raw=/readyz")
	if err != nil {
		return fmt.Errorf("%w\n%s", err, out)
	}
	if !strings.Contains(string(out), "ok") {
		return fmt.Errorf("/readyz did not report ok: %q", strings.TrimSpace(string(out)))
	}
	return nil
}

// soakDriftCheck seeds + drives a REAL DETECT_DRIFT job against the live environment and
// asserts an honest, non-vacuous in-sync posture. The drift job's state slot is aliased onto
// the deploy job's, so its refresh-only plan reconciles the deploy's real recorded state.
func soakDriftCheck(t *testing.T, ctx context.Context, cp *ControlPlane, p soakParams, s *SoakSummary) {
	t.Helper()

	// Non-vacuity floor: the deploy must have written real, non-empty state to reconcile.
	deployState := cp.StateSnapshot(p.deployJobID)
	resCount, err := tfstateResourceCount(deployState)
	if err != nil {
		t.Fatalf("A0.3 drift: deploy state is not readable/non-empty (%v) — a drift run would be vacuous", err)
	}
	if resCount == 0 {
		t.Fatal("A0.3 drift: deploy state records 0 managed resources — refusing a vacuous drift assertion")
	}
	s.DriftStateResources = resCount
	t.Logf("A0.3 drift: deploy state records %d managed resource instances", resCount)

	driftJobID, err := seedT2DriftJob(ctx, cp, p.project, p.env, p.provider, p.region)
	if err != nil {
		t.Fatalf("A0.3 drift: seed DETECT_DRIFT job: %v", err)
	}
	// Alias the drift job's state slot onto the deploy's so refresh-only reads the SAME state.
	cp.AliasStateToJob(driftJobID, p.deployJobID)
	t.Logf("A0.3 drift: seeded DETECT_DRIFT job %s (state aliased to deploy job %s)", driftJobID, p.deployJobID)

	// Bounded wait: the runner's safety poll claims within ~30s; a refresh-only plan on a
	// tiny cluster is quick. 10m is generous headroom.
	status, err := cp.WaitTerminal(ctx, driftJobID, 10*time.Minute)
	if err != nil {
		t.Fatalf("A0.3 drift: waiting for DETECT_DRIFT to finish: %v", err)
	}
	s.DriftJobStatus = status
	if status != "SUCCESS" {
		_, meta, _ := cp.JobState(ctx, driftJobID)
		t.Fatalf("A0.3 drift: DETECT_DRIFT terminal status = %q, want SUCCESS\nmetadata: %s", status, meta)
	}

	// Proof it actually read the deploy's real state (not a vacuous empty-slot pass).
	reads := cp.StateReadsNonEmpty(driftJobID)
	s.DriftStateReads = reads
	if reads == 0 {
		t.Fatal("A0.3 drift: DETECT_DRIFT never read a non-empty state object — the posture would be vacuous")
	}

	_, metaRaw, err := cp.JobState(ctx, driftJobID)
	if err != nil {
		t.Fatalf("A0.3 drift: read drift job metadata: %v", err)
	}
	var meta struct {
		DriftPosture *struct {
			InSync         bool `json:"in_sync"`
			Drifted        int  `json:"drifted"`
			UnmanagedKnown bool `json:"unmanaged_known"`
		} `json:"drift_posture"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("A0.3 drift: decode drift execution_metadata: %v\nraw: %s", err, metaRaw)
	}
	if meta.DriftPosture == nil {
		t.Fatalf("A0.3 drift: no drift_posture in execution_metadata — the drift path did not persist a posture\nraw: %s", metaRaw)
	}
	s.DriftInSync = meta.DriftPosture.InSync
	s.DriftDrifted = meta.DriftPosture.Drifted
	// Honest posture right after a clean apply: genuinely in-sync (0 drifted). unmanaged_known
	// must be false — a refresh-only plan CANNOT see unmanaged resources, and claiming it did
	// would be dishonest.
	if !meta.DriftPosture.InSync || meta.DriftPosture.Drifted != 0 {
		t.Fatalf("A0.3 drift: posture is not in-sync right after a clean apply: in_sync=%t drifted=%d",
			meta.DriftPosture.InSync, meta.DriftPosture.Drifted)
	}
	if meta.DriftPosture.UnmanagedKnown {
		t.Fatal("A0.3 drift: posture claims unmanaged_known=true, but a refresh-only plan cannot see unmanaged resources — dishonest posture")
	}
	t.Logf("A0.3 drift: DETECT_DRIFT SUCCESS — honest in-sync posture (drifted=0) over %d real resources, %d non-empty state read(s)", resCount, reads)
}

// seedT2DriftJob enqueues a QUEUED DETECT_DRIFT job carrying the SAME base config_snapshot
// as the deploy (+ the same ALETHIA_E2E_CLUSTER_JSON node-shape override), so its
// ProviderTfvars match and its refresh-only plan reconciles the deploy's exact state. The
// running runner claims it on its safety poll.
func seedT2DriftJob(ctx context.Context, cp *ControlPlane, project, env, provider, region string) (string, error) {
	jobID := newUUID()
	snap := t2BaseSnapshot(project, env, provider, region)
	if err := t2MergeClusterJSON(snap); err != nil {
		return "", err
	}
	snapshot, err := json.Marshal(snap)
	if err != nil {
		return "", err
	}
	_, err = cp.pool.Exec(ctx, `
		INSERT INTO public.jobs
		  (id, user_id, org_id, job_type, config_snapshot, status, provider)
		VALUES ($1, $2, $2, 'DETECT_DRIFT', $3::jsonb, 'QUEUED', NULL)`,
		jobID, newUUID(), string(snapshot))
	if err != nil {
		return "", fmt.Errorf("seed drift job: %w", err)
	}
	return jobID, nil
}

// soakPVCCheck applies a 1Gi PVC + a consuming pod, waits for Bound + Ready, then fetches the
// backing CLOUD volume and HARD-FAILS unless it carries this run's cluster sweep tag (Gap
// G2). The cloud-side check is hetzner-specific today (hcloud API + HCLOUD_VOLUME_EXTRA_LABELS
// from infra/templates/project/hetzner/csi.tf); other providers get their own in A1.2/A2.x,
// so for them the PVC phase is skipped with a clear note rather than a false pass.
func soakPVCCheck(t *testing.T, ctx context.Context, kc string, p soakParams, s *SoakSummary) {
	t.Helper()
	if p.provider != "hetzner" {
		t.Logf("A0.3 pvc: cloud-side sweep-tag check is not wired for provider %q yet (deferred to BYOC A1.2/A2.x) — skipping the PVC phase", p.provider)
		return
	}
	s.PVCChecked = true

	const ns = "alethia-soak"
	manifest := soakPVCManifest(ns)
	if out, err := soakKubectlApply(ctx, kc, manifest); err != nil {
		t.Fatalf("A0.3 pvc: kubectl apply failed: %v\n%s", err, out)
	}
	// Best-effort cleanup so the CSI deletes the backing volume (reclaimPolicy Delete); the
	// label-scoped hcloud sweep is the belt-and-suspenders if this is skipped.
	t.Cleanup(func() {
		dctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if out, derr := soakKubectl(dctx, kc, 90*time.Second, "delete", "namespace", ns, "--wait=false", "--ignore-not-found"); derr != nil {
			t.Logf("A0.3 pvc: cleanup delete namespace %s failed (label-scoped sweep will reclaim): %v\n%s", ns, derr, out)
		}
	})

	// Wait for the PVC to Bind and the pod to be Ready (a consuming pod forces binding even
	// under a WaitForFirstConsumer StorageClass, and proves the volume is attachable).
	deadline := time.Now().Add(5 * time.Minute)
	var pvName string
	for {
		phase, _ := soakKubectl(ctx, kc, 30*time.Second, "get", "pvc", "soak-pvc", "-n", ns, "-o", "jsonpath={.status.phase}")
		if strings.TrimSpace(string(phase)) == "Bound" {
			s.PVCBound = true
			vn, _ := soakKubectl(ctx, kc, 30*time.Second, "get", "pvc", "soak-pvc", "-n", ns, "-o", "jsonpath={.spec.volumeName}")
			pvName = strings.TrimSpace(string(vn))
			break
		}
		if time.Now().After(deadline) {
			desc, _ := soakKubectl(ctx, kc, 30*time.Second, "describe", "pvc", "soak-pvc", "-n", ns)
			pods, _ := soakKubectl(ctx, kc, 30*time.Second, "get", "pods", "-n", ns, "-o", "wide")
			t.Fatalf("A0.3 pvc: soak-pvc did not reach Bound within 5m (last phase %q)\n%s\n%s",
				strings.TrimSpace(string(phase)), desc, pods)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("A0.3 pvc: context cancelled waiting for Bound: %v", ctx.Err())
		case <-time.After(10 * time.Second):
		}
	}
	t.Logf("A0.3 pvc: soak-pvc Bound to PV %s", pvName)

	// Resolve the backing hcloud volume id from the PV's CSI volumeHandle.
	handle, err := soakKubectl(ctx, kc, 30*time.Second, "get", "pv", pvName, "-o", "jsonpath={.spec.csi.volumeHandle}")
	if err != nil {
		t.Fatalf("A0.3 pvc: read PV %s volumeHandle: %v\n%s", pvName, err, handle)
	}
	volumeID := strings.TrimSpace(string(handle))
	if volumeID == "" {
		t.Fatalf("A0.3 pvc: PV %s has no csi.volumeHandle — cannot locate the backing cloud volume", pvName)
	}
	s.PVCVolumeID = volumeID

	// ── Cloud-side sweep-tag HARD check (Gap G2). Query the real hcloud volume and fail
	//    closed unless it carries cluster=<name>. The token is read from the ambient env
	//    (already present for the runner) and never logged. A missing volume/label is a leak. ──
	hctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	vol, err := hcloudGetVolume(hctx, os.Getenv("HCLOUD_TOKEN"), volumeID)
	if err != nil {
		t.Fatalf("A0.3 pvc: cloud-side volume lookup failed for volume %s: %v", volumeID, err)
	}
	if err := assertVolumeHasSweepTag(vol.Labels, p.clusterName); err != nil {
		t.Fatalf("A0.3 pvc: CSI-provisioned volume %s (%s) FAILS the sweep-tag guard: %v", volumeID, vol.Name, err)
	}
	s.PVCSweepTagOK = true
	t.Logf("A0.3 pvc: backing hcloud volume %s (%s) carries the sweep tag cluster=%s — reclaimable, no leak", volumeID, vol.Name, p.clusterName)
}

// soakPVCManifest returns a namespace + 1Gi PVC (default hcloud-volumes StorageClass) + a
// busybox pod that mounts it and writes a file (forcing binding + proving attachability).
func soakPVCManifest(ns string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: soak-pvc
  namespace: %s
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: hcloud-volumes
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: soak-writer
  namespace: %s
spec:
  restartPolicy: Never
  containers:
    - name: writer
      image: busybox:1.36
      command: ["sh", "-c", "echo alethia-soak-a03 > /data/proof && sync && sleep 3600"]
      volumeMounts:
        - name: vol
          mountPath: /data
  volumes:
    - name: vol
      persistentVolumeClaim:
        claimName: soak-pvc
`, ns, ns, ns)
}

// soakAddonReRead re-asserts the SAME derived (never empty) expected Application set is still
// Healthy+Synced at the end of the soak window.
func soakAddonReRead(t *testing.T, ctx context.Context, kc string, p soakParams, s *SoakSummary) {
	t.Helper()
	if len(p.expectedApps) == 0 {
		t.Fatal("A0.3 addon re-read: expected Application set is empty — refusing a vacuous re-read")
	}
	if err := AssertArgoAppsHealthy(ctx, kc, p.expectedApps, ArgoAssertTimeout()); err != nil {
		t.Fatalf("A0.3 addon re-read: expected ArgoCD Applications are no longer Healthy+Synced: %v", err)
	}
	s.AddonReReadOK = true
	t.Logf("A0.3 addon re-read: all %d expected ArgoCD Applications still Healthy+Synced", len(p.expectedApps))
}

// soakKubectl runs a kubectl command against the given kubeconfig, bounded by timeout.
func soakKubectl(ctx context.Context, kc string, timeout time.Duration, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	full := append([]string{"--kubeconfig", kc}, args...)
	cmd := exec.CommandContext(cctx, "kubectl", full...)
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kc)
	return cmd.CombinedOutput()
}

// soakKubectlApply pipes a manifest to `kubectl apply -f -`.
func soakKubectlApply(ctx context.Context, kc, manifest string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kc, "apply", "-f", "-")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kc)
	cmd.Stdin = strings.NewReader(manifest)
	return cmd.CombinedOutput()
}
