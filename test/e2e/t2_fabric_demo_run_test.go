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

// runT2FabricDemo drives the #845 acceptance gate on the Fabric the base run provisioned: place each
// tier as a namespace env syncing its OWN Kustomize overlay, place one tier as a vcluster env, prove
// every placement genuinely CAUSED the artifacts it is credited with, re-prove the Fabric's drift
// posture, and record the whole thing as a machine-readable verdict.
func runT2FabricDemo(t *testing.T, ctx context.Context, cp *ControlPlane, kc string, p fabricDemoParams) {
	summary := FabricDemoSummary{
		Provider:     p.provider,
		Fabric:       p.fabricClust,
		ReceiptScope: "fabric",
		BaseAppsRepo: p.baseAppsRepo,
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

	tiers, err := fabricDemoTiers(p.env, p.provider)
	if err != nil {
		t.Fatalf("fabric-demo: %v", err)
	}
	repo := fabricDemoRepo(p.provider)
	if strings.TrimSpace(repo) == "" {
		t.Fatalf("fabric-demo: %s resolved empty — with no apps repo nothing is delivered and the gate would prove nothing", envFabricDemoRepo)
	}
	summary.Repo = repo
	// Refuse the ambiguous setup BEFORE seeding any job or spending any cloud time.
	if err := fabricDemoRepoPrecondition(p.baseAppsRepo, repo); err != nil {
		t.Fatalf("fabric-demo: %v", err)
	}
	vcTier, err := fabricDemoVClusterTier(p.provider, tiers)
	if err != nil {
		t.Fatalf("fabric-demo: %v", err)
	}
	// The Fabric's plan digest was VERIFIED by the base run (VerifySignedReceipt). Carrying it here
	// is what ties these placements to a proven Fabric; an absent digest fails the verdict rather
	// than quietly reporting placements on an unproven cluster.
	summary.FabricPlanSHA = strings.TrimSpace(p.planSHA)

	timeout := fabricDemoTimeout()
	t.Logf("fabric-demo (#845): placing %d namespace tier(s) %v + one vcluster tier (%s) onto Fabric %q from %s (bound %s)",
		len(tiers), tiers, vcTier.Tier, p.fabricClust, repo, timeout)

	// ── (0) CAUSALITY BASELINE ────────────────────────────────────────────────────────────────
	//    The base deploy already populated this Fabric with Applications, AppProjects and
	//    Namespaces. Everything asserted below must be proven NEW against this snapshot; without
	//    it, an artifact the base run created reads as a placement's work and the gate is theatre.
	beforeApps, err := kubeIdentsOf(ctx, kc, "applications", "argocd")
	if err != nil {
		t.Fatalf("fabric-demo: causality baseline (applications): %v", err)
	}
	beforeProjects, err := kubeIdentsOf(ctx, kc, "appprojects", "argocd")
	if err != nil {
		t.Fatalf("fabric-demo: causality baseline (appprojects): %v", err)
	}
	beforeNS, err := kubeIdentsOf(ctx, kc, "namespaces", "")
	if err != nil {
		t.Fatalf("fabric-demo: causality baseline (namespaces): %v", err)
	}
	summary.PreExistingApps = len(beforeApps)
	t.Logf("fabric-demo: causality baseline — %d Application(s), %d AppProject(s), %d Namespace(s) existed BEFORE any placement",
		len(beforeApps), len(beforeProjects), len(beforeNS))

	// ArgoCD must survive every placement — capture its identity once, before any of them.
	argoBefore, err := nsKubectl(ctx, kc, "get", "deployment", "argocd-server", "-n", "argocd", "-o", "jsonpath={.metadata.creationTimestamp}")
	if err != nil {
		t.Fatalf("fabric-demo: read argocd-server before placements: %v\n%s", err, argoBefore)
	}

	// ── (1) Place every tier as a namespace env on the SAME Fabric, and prove what it delivered ──
	for _, tier := range tiers {
		res := FabricDemoTier{Tier: tier.Tier, Namespace: tier.Namespace}
		record := func() { summary.Tiers = append(summary.Tiers, res) }

		// A tier namespace that already exists means the base leg is already delivering this
		// overlay — the placement would have nothing left to prove and two Applications would
		// fight over one namespace.
		if _, exists := beforeNS[tier.Namespace]; exists {
			record()
			t.Fatalf("fabric-demo: namespace %q already existed BEFORE the %s placement — the base deploy is already delivering this overlay, so the placement proves nothing. Point %s at a different repo, or disable this gate for this leg",
				tier.Namespace, tier.Tier, envArgoAppsRepo)
		}

		snap := buildFabricDemoSnapshot(p, tier, repo)
		jobID, err := seedT2DeployJob(ctx, cp, snap, nil, p.owner)
		if err != nil {
			record()
			t.Fatalf("fabric-demo: seed %s placement DEPLOY: %v", tier.Tier, err)
		}
		t.Logf("fabric-demo: seeded QUEUED %s placement DEPLOY %s (namespace=%s, overlay=%s)",
			tier.Tier, jobID, tier.Namespace, fabricDemoOverlayPath(tier.Tier))

		status, err := cp.WaitTerminal(ctx, jobID, timeout)
		if err != nil {
			record()
			t.Fatalf("fabric-demo: waiting for the %s placement: %v", tier.Tier, err)
		}
		if status != "SUCCESS" {
			record()
			t.Fatalf("fabric-demo: %s placement terminal status = %q, want SUCCESS", tier.Tier, status)
		}

		// It must have landed on the EXISTING Fabric — a placement that provisioned its own cluster
		// is the failure this whole model exists to prevent.
		_, metaRaw, err := cp.JobState(ctx, jobID)
		if err != nil {
			record()
			t.Fatalf("fabric-demo: read %s placement metadata: %v", tier.Tier, err)
		}
		var meta struct {
			ClusterName string `json:"cluster_name"`
		}
		if err := json.Unmarshal(metaRaw, &meta); err != nil {
			record()
			t.Fatalf("fabric-demo: decode %s placement metadata: %v\nraw: %s", tier.Tier, err, metaRaw)
		}
		if err := namespaceClusterUnchanged(p.fabricClust, meta.ClusterName); err != nil {
			record()
			t.Fatalf("fabric-demo: %s placement no-new-cluster assertion: %v", tier.Tier, err)
		}
		res.Placed = true

		// (a) The artifact the placement ACTUALLY creates: a tenant Application in a hardened
		//     per-namespace AppProject. findNamespaceApp already fails closed on a wrong destination
		//     server and on the wide-open infra/apps projects.
		appsJSON, err := nsKubectl(ctx, kc, "get", "applications", "-n", "argocd", "-o", "json")
		if err != nil {
			record()
			t.Fatalf("fabric-demo: list applications after the %s placement: %v\n%s", tier.Tier, err, appsJSON)
		}
		app, err := findNamespaceApp([]byte(appsJSON), tier.Namespace)
		if err != nil {
			record()
			t.Fatalf("fabric-demo: %s placement delivery: %v", tier.Tier, err)
		}
		res.TenantApp = app.Metadata.Name
		res.TenantProject = app.Spec.Project

		// (b) CAUSALITY: both the Application and its AppProject must be NEW.
		afterApps, err := kubeIdentsOf(ctx, kc, "applications", "argocd")
		if err != nil {
			record()
			t.Fatalf("fabric-demo: re-read applications after the %s placement: %v", tier.Tier, err)
		}
		afterProjects, err := kubeIdentsOf(ctx, kc, "appprojects", "argocd")
		if err != nil {
			record()
			t.Fatalf("fabric-demo: re-read appprojects after the %s placement: %v", tier.Tier, err)
		}
		if err := assertCausedByPlacement("Application", app.Metadata.Name, beforeApps, afterApps); err != nil {
			record()
			t.Fatalf("fabric-demo: %s placement causality: %v", tier.Tier, err)
		}
		if err := assertCausedByPlacement("AppProject", app.Spec.Project, beforeProjects, afterProjects); err != nil {
			record()
			t.Fatalf("fabric-demo: %s placement causality: %v", tier.Tier, err)
		}
		res.CausedByPlacement = true

		// (c) THE CLAIM: it syncs THIS tier's overlay from THIS repo, not the repository root.
		if err := assertTenantAppOverlay(app, repo, tier.Tier); err != nil {
			record()
			t.Fatalf("fabric-demo: %s overlay routing: %v", tier.Tier, err)
		}
		res.SourcePath = strings.TrimSpace(app.Spec.Source.Path)

		// (d) The hardened AppProject really is locked down (mirrors #959's assertion).
		cw, err := nsKubectl(ctx, kc, "get", "appproject", app.Spec.Project, "-n", "argocd", "-o", "jsonpath={.spec.clusterResourceWhitelist}")
		if err != nil {
			record()
			t.Fatalf("fabric-demo: read AppProject %q: %v\n%s", app.Spec.Project, err, cw)
		}
		if w := strings.TrimSpace(cw); w != "" && w != "[]" {
			record()
			t.Fatalf("fabric-demo: tenant AppProject %q clusterResourceWhitelist = %q, want empty — a namespace tenant must not create cluster-scoped resources", app.Spec.Project, w)
		}

		// (e) Converged, then the non-vacuity floor.
		if _, err := waitNamespaceAppConverged(ctx, kc, tier.Namespace, timeout); err != nil {
			record()
			t.Fatalf("fabric-demo: %s overlay: %v", tier.Tier, err)
		}
		res.Converged = true
		if err := assertArgoAppManagesResources(ctx, kc, app.Metadata.Name); err != nil {
			record()
			t.Fatalf("fabric-demo: %s overlay manages no resources: %v", tier.Tier, err)
		}
		n, err := argoAppResourceCount(ctx, kc, app.Metadata.Name)
		if err != nil {
			record()
			t.Fatalf("fabric-demo: %s overlay resource count: %v", tier.Tier, err)
		}
		res.ResourceCount = n
		record()
		t.Logf("fabric-demo: %s → Application %q (project %q) Healthy+Synced from %q into ns %q managing %d resource(s)",
			tier.Tier, app.Metadata.Name, app.Spec.Project, res.SourcePath, tier.Namespace, n)
	}

	// ── (2) The vcluster tier — #845's headline differentiator ────────────────────────────────
	//    Reuses #1308's whole proof body (place → register → deliver → deregister) rather than a
	//    forked copy that would drift, with the resource floor and the overlay path turned ON.
	vcName := fabricDemoVClusterSlug(p.env)
	summary.VCluster = FabricDemoVCluster{Name: vcName, Tier: vcTier.Tier}
	if _, exists := beforeNS[vcHostNamespacePrefix+vcName]; exists {
		t.Fatalf("fabric-demo: host namespace %q already existed BEFORE the vcluster placement", vcHostNamespacePrefix+vcName)
	}
	var vcRes vclusterTenantResult
	func() {
		// Copy the partial result out however the body exits, so a t.Fatalf inside it still leaves
		// the deferred summary write an honest record of how far the vcluster tier got.
		defer func() {
			summary.VCluster.Placed = vcRes.Placed
			summary.VCluster.App = vcRes.App
			summary.VCluster.SourcePath = vcRes.SourcePath
			summary.VCluster.ResourceCount = vcRes.ResourceCount
			summary.VCluster.Deregistered = vcRes.Deregistered
		}()
		driveT2VClusterTenant(t, ctx, cp, kc, vclusterTenantParams{
			project: p.project, env: p.env, provider: p.provider, region: p.region,
			fabricClust: p.fabricClust, owner: p.owner,
			appsRepo: repo, appsPath: fabricDemoOverlayPath(vcTier.Tier),
			vcName: vcName, label: "fabric-demo vcluster tier (#845)", requireAppResources: true,
		}, &vcRes)
	}()

	if vcRes.App != "" {
		afterApps, err := kubeIdentsOf(ctx, kc, "applications", "argocd")
		if err != nil {
			t.Fatalf("fabric-demo: re-read applications after the vcluster placement: %v", err)
		}
		if err := assertCausedByPlacement("Application", vcRes.App, beforeApps, afterApps); err != nil {
			t.Fatalf("fabric-demo: vcluster tier causality: %v", err)
		}
		summary.VCluster.CausedByPlacement = true
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

// kubeIdentsOf lists a kind and returns name → identity, for the causality baseline. ns == "" lists
// cluster-scoped objects (namespaces).
func kubeIdentsOf(ctx context.Context, kc, kind, ns string) (map[string]kubeIdent, error) {
	args := []string{"get", kind}
	if ns != "" {
		args = append(args, "-n", ns)
	}
	args = append(args, "-o", "json")
	out, err := nsKubectl(ctx, kc, args...)
	if err != nil {
		return nil, fmt.Errorf("list %s: %v\n%s", kind, err, out)
	}
	return parseKubeIdents([]byte(out))
}

// waitNamespaceAppConverged bounded-polls the placed tenant Application (addressed by its
// destination namespace) until it is Healthy+Synced. A not-found is a retry — ArgoCD needs a cycle
// to register and first-sync the app — but the last routing error is reported verbatim on timeout so
// a misrouted placement is diagnosable from logs alone.
func waitNamespaceAppConverged(ctx context.Context, kc, ns string, timeout time.Duration) (namespaceAppState, error) {
	deadline := time.Now().Add(timeout)
	var last error
	var lastState namespaceAppState
	for {
		listJSON, err := nsKubectl(ctx, kc, "get", "applications", "-n", "argocd", "-o", "json")
		if err != nil {
			last = fmt.Errorf("list applications: %v\n%s", err, listJSON)
		} else {
			app, ferr := findNamespaceApp([]byte(listJSON), ns)
			if ferr != nil {
				last = ferr
			} else {
				lastState = app
				if app.Status.Health.Status == "Healthy" && app.Status.Sync.Status == "Synced" {
					return app, nil
				}
				last = fmt.Errorf("Application %q is health=%q sync=%q, want Healthy+Synced",
					app.Metadata.Name, app.Status.Health.Status, app.Status.Sync.Status)
			}
		}
		if time.Now().After(deadline) {
			return lastState, fmt.Errorf("the placement into %q did not converge within %s: %v", ns, timeout, last)
		}
		select {
		case <-ctx.Done():
			return lastState, fmt.Errorf("context cancelled while waiting for the placement into %s (%v); last: %v", ns, ctx.Err(), last)
		case <-time.After(fabricDemoPollInterval):
		}
	}
}

// fabricDemoDriftCheck seeds a DETECT_DRIFT over the Fabric's real state (aliased to the base
// deploy's state key, exactly as the A0.3 soak does) and records the honest posture. A placement
// changes nothing in tofu, so right after these placements the Fabric must still read in-sync —
// a drifted posture here means a placement touched infrastructure it had no business touching.
func fabricDemoDriftCheck(t *testing.T, ctx context.Context, cp *ControlPlane, p fabricDemoParams, timeout time.Duration, s *FabricDemoSummary) error {
	driftJobID, err := seedT2DriftJob(ctx, cp, p.project, p.env, p.provider, p.region, p.owner)
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
	// details is decoded so a failure NAMES the resources rather than printing two integers.
	var meta struct {
		DriftPosture *struct {
			InSync  bool `json:"in_sync"`
			Drifted int  `json:"drifted"`
			Details []struct {
				Address string `json:"address"`
				Kind    string `json:"kind"`
			} `json:"details"`
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
		drifted := make([]string, 0, len(meta.DriftPosture.Details))
		for _, d := range meta.DriftPosture.Details {
			drifted = append(drifted, d.Address+" ("+d.Kind+")")
		}
		return fmt.Errorf("the Fabric is not in-sync after the placements: in_sync=%t drifted=%d — a namespace placement runs no tofu and must not move infrastructure\ndrifted: %s",
			meta.DriftPosture.InSync, meta.DriftPosture.Drifted, strings.Join(drifted, "\n         "))
	}
	return nil
}
