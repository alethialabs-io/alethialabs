// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// Fabric enterprise-demo acceptance scenario (#845) — the tagged run half. Layered onto the base T2
// provision after the cluster is up + ArgoCD Healthy, INSIDE the same ephemeral cluster lifetime
// (the base's single t.Cleanup destroys it once). Opt-in via ALETHIA_E2E_FABRIC_DEMO. Real-apply is
// main-gated, so this exercises meaningfully only from `main` (e2e-nightly).
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// runT2FabricDemo drives the #845 acceptance gate on the Fabric the base run provisioned: place
// each overlay tier as a namespace env carrying the enterprise-demo apps repo, prove the
// ApplicationSet-generated Kustomize overlay Applications converge and manage real resources,
// re-prove the Fabric's drift posture, and record the whole thing as a machine-readable verdict.
func runT2FabricDemo(t *testing.T, ctx context.Context, cp *ControlPlane, kc string, p fabricDemoParams) {
	summary := FabricDemoSummary{
		Provider:     p.provider,
		Fabric:       p.fabricClust,
		ReceiptScope: "fabric",
	}
	if !fabricDemoEnabled() {
		t.Logf("fabric enterprise-demo scenario (#845) disabled — set %s=1 to run it", envFabricDemo)
		return
	}
	summary.Enabled = true

	// The summary is written on EVERY exit path (including t.Fatalf), so a red run still leaves the
	// proof capture a verdict to fold rather than a missing file that reads as "never ran".
	if path := t2Env(envFabricDemoSummary, ""); path != "" {
		defer func() {
			summary.Verdict = fabricDemoSummaryVerdict(summary)
			if werr := writeFabricDemoSummary(path, summary); werr != nil {
				t.Logf("fabric-demo: could not write summary to %s: %v", path, werr)
			}
		}()
	}

	tiers, err := fabricDemoOverlays(p.provider)
	if err != nil {
		t.Fatalf("fabric-demo: %v", err)
	}
	repo := fabricDemoRepo(p.provider)
	if strings.TrimSpace(repo) == "" {
		t.Fatalf("fabric-demo: %s resolved empty — with no apps repo the ApplicationSet generates nothing and the gate would prove nothing", envFabricDemoRepo)
	}
	summary.Repo = repo
	// The Fabric's plan digest was VERIFIED by the base run (VerifySignedReceipt). Carrying it here
	// is what ties these placements to a proven Fabric; an absent digest fails the verdict rather
	// than quietly reporting placements on an unproven cluster.
	summary.FabricPlanSHA = strings.TrimSpace(p.planSHA)

	timeout := fabricDemoTimeout()
	t.Logf("fabric-demo (#845): placing %d overlay tier(s) %v onto Fabric %q from %s (bound %s)",
		len(tiers), tiers, p.fabricClust, repo, timeout)

	// ArgoCD must survive every placement — capture its identity once, before any of them.
	argoBefore, err := nsKubectl(ctx, kc, "get", "deployment", "argocd-server", "-n", "argocd", "-o", "jsonpath={.metadata.creationTimestamp}")
	if err != nil {
		t.Fatalf("fabric-demo: read argocd-server before placements: %v\n%s", err, argoBefore)
	}

	// ── (1) Place every tier as a namespace env on the SAME Fabric ────────────────────────────
	for _, tier := range tiers {
		ns := fabricDemoSlug(p.env, tier)
		res := FabricDemoTier{Tier: tier, Namespace: ns, OverlayApp: overlayAppName(tier)}

		snap := buildFabricDemoSnapshot(p, tier, ns, repo)
		jobID, err := seedT2DeployJob(ctx, cp, snap, nil, p.owner)
		if err != nil {
			summary.Tiers = append(summary.Tiers, res)
			t.Fatalf("fabric-demo: seed %s placement DEPLOY: %v", tier, err)
		}
		t.Logf("fabric-demo: seeded QUEUED %s placement DEPLOY %s (namespace=%s)", tier, jobID, ns)

		status, err := cp.WaitTerminal(ctx, jobID, timeout)
		if err != nil {
			summary.Tiers = append(summary.Tiers, res)
			t.Fatalf("fabric-demo: waiting for the %s placement: %v", tier, err)
		}
		if status != "SUCCESS" {
			summary.Tiers = append(summary.Tiers, res)
			t.Fatalf("fabric-demo: %s placement terminal status = %q, want SUCCESS", tier, status)
		}

		// It must have landed on the EXISTING Fabric — a placement that provisioned its own cluster
		// is the failure this whole model exists to prevent.
		_, metaRaw, err := cp.JobState(ctx, jobID)
		if err != nil {
			summary.Tiers = append(summary.Tiers, res)
			t.Fatalf("fabric-demo: read %s placement metadata: %v", tier, err)
		}
		var meta struct {
			ClusterName string `json:"cluster_name"`
		}
		if err := json.Unmarshal(metaRaw, &meta); err != nil {
			summary.Tiers = append(summary.Tiers, res)
			t.Fatalf("fabric-demo: decode %s placement metadata: %v\nraw: %s", tier, err, metaRaw)
		}
		if err := namespaceClusterUnchanged(p.fabricClust, meta.ClusterName); err != nil {
			summary.Tiers = append(summary.Tiers, res)
			t.Fatalf("fabric-demo: %s placement no-new-cluster assertion: %v", tier, err)
		}
		res.Placed = true
		summary.Tiers = append(summary.Tiers, res)
		t.Logf("fabric-demo: %s placed into namespace %q on Fabric %q", tier, ns, p.fabricClust)
	}

	// ── (2) The Kustomize overlays converged — the assertion nothing else in test/e2e makes ───
	//    DeriveExpectedArgoApps cannot see ApplicationSet-generated apps, so without this the
	//    multi-environment delivery path has no end-to-end coverage at all.
	for i := range summary.Tiers {
		tier := summary.Tiers[i].Tier
		app, err := waitOverlayAppConverged(ctx, kc, tier, timeout)
		if err != nil {
			t.Fatalf("fabric-demo: overlay %s: %v", tier, err)
		}
		summary.Tiers[i].Converged = true
		summary.Tiers[i].OverlayNS = app.Spec.Destination.Namespace

		// Non-vacuity: Healthy+Synced over an EMPTY overlay directory is trivially true.
		if err := assertArgoAppManagesResources(ctx, kc, app.Metadata.Name); err != nil {
			t.Fatalf("fabric-demo: overlay %s manages no resources: %v", tier, err)
		}
		n, err := overlayResourceCount(ctx, kc, app.Metadata.Name)
		if err != nil {
			t.Fatalf("fabric-demo: overlay %s resource count: %v", tier, err)
		}
		summary.Tiers[i].ResourceCount = n
		t.Logf("fabric-demo: overlay %s → Application %q Healthy+Synced into ns %q managing %d resource(s)",
			tier, app.Metadata.Name, app.Spec.Destination.Namespace, n)
	}

	// ── (3) ArgoCD was never reinstalled by any placement ─────────────────────────────────────
	argoAfter, err := nsKubectl(ctx, kc, "get", "deployment", "argocd-server", "-n", "argocd", "-o", "jsonpath={.metadata.creationTimestamp}")
	if err != nil {
		t.Fatalf("fabric-demo: read argocd-server after placements: %v\n%s", err, argoAfter)
	}
	if err := argocdNotReinstalled(argoBefore, argoAfter); err != nil {
		t.Fatalf("fabric-demo: no-reinstall assertion: %v", err)
	}
	summary.ArgoNotReinstalled = true

	// ── (4) Re-prove the Fabric's drift posture ───────────────────────────────────────────────
	//    The receipt is the Fabric's (a placement runs no tofu — see the file header). Drift is
	//    likewise the Fabric's: a refresh-only plan over the state the base deploy wrote.
	if p.deployJobID != "" {
		if err := fabricDemoDriftCheck(t, ctx, cp, p, timeout, &summary); err != nil {
			t.Fatalf("fabric-demo: drift re-prove: %v", err)
		}
	} else {
		t.Log("fabric-demo: drift re-prove skipped — no base deploy job id to alias state from")
	}

	if !fabricDemoVerdictPass(summary) {
		t.Fatalf("fabric-demo (#845) FAILED: %s", fabricDemoSummaryVerdict(summary))
	}
	t.Logf("fabric-demo (#845) PROVEN: %s", fabricDemoSummaryVerdict(summary))
}

// waitOverlayAppConverged bounded-polls the ApplicationSet-generated Application for a tier until it
// is Healthy+Synced. The generator itself needs a refresh cycle to even CREATE the app, so a
// not-found is a retry, not an immediate failure — but the last routing error is reported verbatim
// on timeout so a misrouted overlay is diagnosable from logs alone.
func waitOverlayAppConverged(ctx context.Context, kc, tier string, timeout time.Duration) (overlayAppState, error) {
	deadline := time.Now().Add(timeout)
	var last error
	var lastState overlayAppState
	for {
		listJSON, err := nsKubectl(ctx, kc, "get", "applications", "-n", "argocd", "-o", "json")
		if err != nil {
			last = fmt.Errorf("list applications: %v\n%s", err, listJSON)
		} else {
			app, ferr := findOverlayApp([]byte(listJSON), tier)
			if ferr != nil {
				last = ferr
			} else {
				lastState = app
				if overlayConverged(app) {
					return app, nil
				}
				last = fmt.Errorf("Application %q is health=%q sync=%q, want Healthy+Synced",
					app.Metadata.Name, app.Status.Health.Status, app.Status.Sync.Status)
			}
		}
		if time.Now().After(deadline) {
			return lastState, fmt.Errorf("overlay did not converge within %s: %v", timeout, last)
		}
		select {
		case <-ctx.Done():
			return lastState, fmt.Errorf("context cancelled while waiting for overlay %s (%v); last: %v", tier, ctx.Err(), last)
		case <-time.After(fabricDemoPollInterval):
		}
	}
}

// overlayResourceCount reads how many manifests the generated Application actually manages. The
// count is the honest "GitOps delivered a workload" signal recorded in the summary;
// assertArgoAppManagesResources already enforces the >0 floor.
func overlayResourceCount(ctx context.Context, kc, name string) (int, error) {
	out, err := nsKubectl(ctx, kc, "get", "applications.argoproj.io", name, "-n", "argocd", "-o", "json")
	if err != nil {
		return 0, fmt.Errorf("read Application %q: %v\n%s", name, err, out)
	}
	var app struct {
		Status struct {
			Resources []struct {
				Kind string `json:"kind"`
			} `json:"resources"`
		} `json:"status"`
	}
	if err := json.Unmarshal([]byte(out), &app); err != nil {
		return 0, fmt.Errorf("decode Application %q: %w", name, err)
	}
	return len(app.Status.Resources), nil
}

// fabricDemoDriftCheck seeds a DETECT_DRIFT over the Fabric's real state (aliased to the base
// deploy's state key, exactly as the A0.3 soak does) and records the honest posture. A placement
// changes nothing in tofu, so right after these placements the Fabric must still read in-sync —
// a drifted posture here means a placement touched infrastructure it had no business touching.
func fabricDemoDriftCheck(t *testing.T, ctx context.Context, cp *ControlPlane, p fabricDemoParams, timeout time.Duration, s *FabricDemoSummary) error {
	driftJobID, err := seedT2DriftJob(ctx, cp, p.project, p.env, p.provider, p.region)
	if err != nil {
		return fmt.Errorf("seed drift job: %w", err)
	}
	cp.AliasStateToJob(driftJobID, p.deployJobID)
	t.Logf("fabric-demo: seeded DETECT_DRIFT %s over the Fabric's state", driftJobID)

	status, err := cp.WaitTerminal(ctx, driftJobID, timeout)
	if err != nil {
		return fmt.Errorf("waiting for the drift job: %w", err)
	}
	if status != "SUCCESS" {
		return fmt.Errorf("drift job terminal status = %q, want SUCCESS", status)
	}
	// Non-vacuity floor, same as the soak's: a drift job that read an EMPTY state proves nothing.
	if reads := cp.StateReadsNonEmpty(driftJobID); reads == 0 {
		return fmt.Errorf("the drift job never read a non-empty state — its posture would be vacuous")
	}
	_, metaRaw, err := cp.JobState(ctx, driftJobID)
	if err != nil {
		return fmt.Errorf("read drift metadata: %w", err)
	}
	var meta struct {
		DriftPosture *struct {
			InSync  bool `json:"in_sync"`
			Drifted int  `json:"drifted"`
		} `json:"drift_posture"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return fmt.Errorf("decode drift metadata: %w\nraw: %s", err, metaRaw)
	}
	if meta.DriftPosture == nil {
		return fmt.Errorf("no drift_posture in execution_metadata — the drift path persisted no posture\nraw: %s", metaRaw)
	}
	s.DriftChecked = true
	s.DriftInSync = meta.DriftPosture.InSync
	s.DriftDrifted = meta.DriftPosture.Drifted
	if !meta.DriftPosture.InSync || meta.DriftPosture.Drifted != 0 {
		return fmt.Errorf("the Fabric is not in-sync after the placements: in_sync=%t drifted=%d — a namespace placement runs no tofu and must not move infrastructure",
			meta.DriftPosture.InSync, meta.DriftPosture.Drifted)
	}
	return nil
}
