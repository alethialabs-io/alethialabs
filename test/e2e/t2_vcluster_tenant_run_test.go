// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// vcluster-placement T2 scenario (#1308) — the tagged run half. Layered onto the base T2 provision
// (t2_provision_test.go) after the cluster is up + ArgoCD Healthy, INSIDE the same ephemeral cluster
// lifetime (the base's single t.Cleanup destroys it once). Opt-in via ALETHIA_E2E_VCLUSTER, on EVERY
// cloud — #1389 wired all five and the product's own allowlist is the single control. Real-apply is
// main-gated — this exercises meaningfully only from `main` (e2e-nightly).
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Contract constants mirrored from packages/core/provisioner/deploy_vcluster.go (a different Go module,
// so the e2e package cannot import them). buildVClusterSpec derives these per-env names off the env's
// namespace (== the vcluster name): the control-plane runs as a StatefulSet named <vcName> in host
// namespace `vcluster-<vcName>`, and exportKubeConfig writes `vcluster-kubeconfig-<vcName>` into argocd.
const (
	vcHostNamespacePrefix    = "vcluster-"
	vcKubeconfigSecretPrefix = "vcluster-kubeconfig-"
)

// runT2VClusterTenant drives the vcluster-placement scenario: seed a second DEPLOY job onto the
// EXISTING Fabric cluster, wait SUCCESS, and assert the virtual cluster was provisioned + registered +
// the app delivered onto it — with no new cloud cluster and no ArgoCD reinstall — then a DESTROY job
// deregisters it cleanly (no orphaned registration). The still-running base runner claims both jobs.
func runT2VClusterTenant(t *testing.T, ctx context.Context, cp *ControlPlane, kc string, p vclusterTenantParams) {
	if !vclusterTenantEnabled() {
		t.Log("vcluster-tenant scenario (#1308) disabled — set ALETHIA_E2E_VCLUSTER=1 to run it")
		return
	}
	driveT2VClusterTenant(t, ctx, cp, kc, p, &vclusterTenantResult{})
}

// driveT2VClusterTenant is the whole placement + registration + delivery + teardown proof, with NO
// enable gate of its own. Two callers: #1308 above (standalone, opt-in), and #845's acceptance gate,
// which REQUIRES a vcluster tier and must record it in its verdict. Splitting the gate from the body
// is what lets #845 reuse this instead of forking a near-identical copy that would drift.
//
// res is filled progressively so a t.Fatalf mid-run still leaves the caller's summary honest about
// how far it got.
func driveT2VClusterTenant(t *testing.T, ctx context.Context, cp *ControlPlane, kc string, p vclusterTenantParams, res *vclusterTenantResult) {
	// NO per-cloud guard here, deliberately — same reasoning as the namespace scenario. A vcluster
	// runs ON the host Fabric and reaches it exactly as the host does, so it was never truly
	// aws-specific; #1389 wired the remaining clouds and the product's own allowlist
	// (provisioner.vclusterPlacementProviders) is the SINGLE control. Keeping `p.provider != "aws"`
	// here would be a second literal that silently skipped 4 of 5 clouds — the vcluster tier is the
	// headline differentiator #845 asks to prove on ALL of them, so a skip that reads green is the
	// worst possible outcome. An unwired cloud now fails the placement job closed, with a reason.

	vcName := vclusterTenantName(p)
	label := vclusterTenantLabel(p)
	hostNS := vcHostNamespacePrefix + vcName
	kubeconfigSecret := vcKubeconfigSecretPrefix + vcName
	res.Name = vcName
	t.Logf("%s: placing a vcluster env %q onto the EXISTING Fabric cluster %q (host ns %q)", label, vcName, p.fabricClust, hostNS)

	// Capture the argocd-server creationTimestamp BEFORE — the vcluster deploy must NOT reinstall the
	// shared Fabric's ArgoCD (it belongs to the Fabric; the vcluster registers WITH it).
	argoBefore, err := nsKubectl(ctx, kc, "get", "deployment", "argocd-server", "-n", "argocd", "-o", "jsonpath={.metadata.creationTimestamp}")
	if err != nil {
		t.Fatalf("read argocd-server before vcluster deploy: %v\n%s", err, argoBefore)
	}

	// ── 1. Seed the vcluster DEPLOY job (owner = the SeedRunner owner so the running base runner claims it). ──
	snap := buildVClusterSnapshot(p, vcName)
	jobID, err := seedT2DeployJob(ctx, cp, snap, nil, p.owner)
	if err != nil {
		t.Fatalf("seed vcluster DEPLOY job: %v", err)
	}
	t.Logf("seeded QUEUED vcluster DEPLOY job %s (placement=vcluster, cluster=%s, vcluster=%s)", jobID, p.fabricClust, vcName)

	status, err := cp.WaitTerminal(ctx, jobID, vcDeployWait)
	if err != nil {
		t.Fatalf("waiting for vcluster DEPLOY job: %v", err)
	}
	if status != "SUCCESS" {
		t.Fatalf("vcluster DEPLOY job terminal status = %q, want SUCCESS", status)
	}

	// (a) The deploy reported the vcluster's OWN name as its cluster (result.ClusterName = spec.Name).
	_, metaRaw, err := cp.JobState(ctx, jobID)
	if err != nil {
		t.Fatalf("read vcluster DEPLOY job metadata: %v", err)
	}
	var meta struct {
		ClusterName string `json:"cluster_name"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("decode vcluster DEPLOY job metadata: %v\nraw: %s", err, metaRaw)
	}
	if meta.ClusterName != vcName {
		t.Fatalf("vcluster DEPLOY job cluster_name = %q, want the vcluster name %q", meta.ClusterName, vcName)
	}
	res.Placed = true

	// (b) The vcluster control-plane StatefulSet is Ready in `vcluster-<vcName>` on the SAME Fabric
	//     (read over the SAME host kubeconfig — proof no new cloud cluster was provisioned).
	ready, err := nsKubectl(ctx, kc, "get", "statefulset", vcName, "-n", hostNS, "-o", "jsonpath={.status.readyReplicas}")
	if err != nil {
		t.Fatalf("get vcluster StatefulSet %s/%s: %v\n%s", hostNS, vcName, err, ready)
	}
	if strings.TrimSpace(ready) == "" || strings.TrimSpace(ready) == "0" {
		t.Fatalf("vcluster StatefulSet %s/%s readyReplicas = %q, want ≥ 1 (control plane not ready)", hostNS, vcName, strings.TrimSpace(ready))
	}

	// (c) The host ArgoCD carries a `cluster` Secret named <vcName> (the registration landed).
	secretsJSON, err := nsKubectl(ctx, kc, "get", "secrets", "-n", "argocd", "-l", "argocd.argoproj.io/secret-type=cluster", "-o", "json")
	if err != nil {
		t.Fatalf("list argocd cluster secrets: %v\n%s", err, secretsJSON)
	}
	if err := findVClusterClusterSecret([]byte(secretsJSON), vcName); err != nil {
		t.Fatalf("vcluster registration assertion: %v", err)
	}
	t.Logf("vcluster %q registered with host ArgoCD (cluster Secret present)", vcName)

	// (d) The tenant app Application routes to the vcluster by destination.name and syncs Healthy —
	//     only when an apps repo was configured (an app was delivered).
	if p.appsRepo != "" {
		app := waitVClusterAppHealthy(t, ctx, kc, vcName, vcAppHealthWait)
		res.App = app.Metadata.Name
		res.SourcePath = strings.TrimSpace(app.Spec.Source.Path)
		t.Logf("%s: tenant app %q routed to vcluster %q (project %q, name-based) — Healthy + Synced", label, app.Metadata.Name, vcName, app.Spec.Project)

		// The non-vacuity floor, on only for callers that asked for it (#845). Healthy+Synced over an
		// empty directory is trivially true, so without a managed-resource count and a source-path
		// check "the overlay converged" can mean "nothing was delivered, twice".
		if p.requireAppResources {
			if err := assertArgoAppManagesResources(ctx, kc, app.Metadata.Name); err != nil {
				t.Fatalf("%s: vcluster app delivered nothing: %v", label, err)
			}
			n, err := argoAppResourceCount(ctx, kc, app.Metadata.Name)
			if err != nil {
				t.Fatalf("%s: read managed resource count: %v", label, err)
			}
			res.ResourceCount = n
			if want := strings.TrimSpace(p.appsPath); want != "" && res.SourcePath != want {
				t.Fatalf("%s: vcluster app %q syncs %q, want %q — the per-tier overlay never reached the runner", label, app.Metadata.Name, res.SourcePath, want)
			}
			t.Logf("%s: vcluster app manages %d resource(s) from %q", label, n, res.SourcePath)
		}
	} else {
		t.Logf("%s: no apps repo configured — vcluster provisioned + registered; skipping the app-delivery assertion", label)
	}

	// (e) ArgoCD was NOT reinstalled — creationTimestamp unchanged.
	argoAfter, err := nsKubectl(ctx, kc, "get", "deployment", "argocd-server", "-n", "argocd", "-o", "jsonpath={.metadata.creationTimestamp}")
	if err != nil {
		t.Fatalf("read argocd-server after vcluster deploy: %v\n%s", err, argoAfter)
	}
	if err := argocdNotReinstalled(argoBefore, argoAfter); err != nil {
		t.Fatalf("no-reinstall assertion: %v", err)
	}

	// ── 2. Teardown: a DESTROY job runs runVClusterDestroy → helm uninstall + both Secrets removed. ──
	destroyID, err := seedT2VClusterDestroyJob(ctx, cp, snap, p.owner)
	if err != nil {
		t.Fatalf("seed vcluster DESTROY job: %v", err)
	}
	t.Logf("seeded QUEUED vcluster DESTROY job %s (deregister vcluster=%s)", destroyID, vcName)

	dstatus, err := cp.WaitTerminal(ctx, destroyID, vcDestroyWait)
	if err != nil {
		t.Fatalf("waiting for vcluster DESTROY job: %v", err)
	}
	if dstatus != "SUCCESS" {
		t.Fatalf("vcluster DESTROY job terminal status = %q, want SUCCESS", dstatus)
	}

	// (f) The control-plane StatefulSet (helm release) is gone.
	if err := assertKubeResourceGone(ctx, kc, "statefulset", vcName, hostNS); err != nil {
		t.Fatalf("vcluster teardown: %v", err)
	}
	// (g) The ArgoCD cluster registration Secret is gone (no orphaned registration).
	if err := assertKubeResourceGone(ctx, kc, "secret", vcName, "argocd"); err != nil {
		t.Fatalf("vcluster teardown: ArgoCD cluster Secret leaked: %v", err)
	}
	// (h) The exported kubeconfig Secret (the standing credential) is gone.
	if err := assertKubeResourceGone(ctx, kc, "secret", kubeconfigSecret, "argocd"); err != nil {
		t.Fatalf("vcluster teardown: exported kubeconfig Secret leaked: %v", err)
	}
	res.Deregistered = true

	t.Logf("%s PROVEN: virtual cluster %q provisioned + registered + app delivered on the SAME Fabric %q, ArgoCD not reinstalled, and torn down cleanly (no orphaned registration)", label, vcName, p.fabricClust)
}

// waitVClusterAppHealthy polls until the tenant app Application (routed to vcName) reports Synced +
// Healthy, or fails the test on timeout. Returns the matched Application for logging.
func waitVClusterAppHealthy(t *testing.T, ctx context.Context, kc, vcName string, timeout time.Duration) vclusterAppState {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var lastErr error
	var lastHealth, lastSync string
	for {
		appsJSON, err := nsKubectl(ctx, kc, "get", "applications", "-n", "argocd", "-o", "json")
		if err != nil {
			lastErr = fmt.Errorf("list applications: %v\n%s", err, appsJSON)
		} else {
			app, ferr := findVClusterApp([]byte(appsJSON), vcName)
			if ferr != nil {
				lastErr = ferr
			} else {
				// Re-read the health/sync status of the matched app by name (findVClusterApp only reads
				// routing fields).
				health, _ := nsKubectl(ctx, kc, "get", "application", app.Metadata.Name, "-n", "argocd", "-o", "jsonpath={.status.health.status}")
				sync, _ := nsKubectl(ctx, kc, "get", "application", app.Metadata.Name, "-n", "argocd", "-o", "jsonpath={.status.sync.status}")
				lastHealth, lastSync = strings.TrimSpace(health), strings.TrimSpace(sync)
				if lastHealth == "Healthy" && lastSync == "Synced" {
					return app
				}
				lastErr = fmt.Errorf("app %q health=%q sync=%q, want Healthy/Synced", app.Metadata.Name, lastHealth, lastSync)
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("vcluster app never reached Healthy+Synced within %s: %v", timeout, lastErr)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("context cancelled waiting for vcluster app health: %v", ctx.Err())
		case <-time.After(15 * time.Second):
		}
	}
}

// assertKubeResourceGone returns nil iff `kubectl get <kind> <name> -n <ns>` reports the resource does
// not exist (a NotFound error) — the teardown assertion. A resource that still exists (or an
// unexpected error) fails closed.
func assertKubeResourceGone(ctx context.Context, kc, kind, name, ns string) error {
	out, err := nsKubectl(ctx, kc, "get", kind, name, "-n", ns, "--ignore-not-found", "-o", "name")
	if err != nil {
		// --ignore-not-found makes NotFound exit 0 with empty output; any error here is a real failure.
		return fmt.Errorf("checking %s %s/%s is gone: %v\n%s", kind, ns, name, err, out)
	}
	if strings.TrimSpace(out) != "" {
		return fmt.Errorf("%s %s/%s still exists after teardown: %q", kind, ns, name, strings.TrimSpace(out))
	}
	return nil
}

// seedT2VClusterDestroyJob enqueues a QUEUED DESTROY job carrying the vcluster config_snapshot so the
// running runner claims it and routes placement_mode=vcluster → runVClusterDestroy. owner MUST equal
// the SeedRunner owner (mirrors the deploy seed), or the self-runner claim never matches. Mirrors
// seedT2DriftJob's INSERT shape.
func seedT2VClusterDestroyJob(ctx context.Context, cp *ControlPlane, snap map[string]any, owner string) (string, error) {
	jobID := newUUID()
	snapshot, err := json.Marshal(snap)
	if err != nil {
		return "", err
	}
	_, err = cp.pool.Exec(ctx, `
		INSERT INTO public.jobs
		  (id, user_id, org_id, job_type, config_snapshot, status, provider)
		VALUES ($1, $2, $2, 'DESTROY', $3::jsonb, 'QUEUED', NULL)`,
		jobID, owner, string(snapshot))
	if err != nil {
		return "", fmt.Errorf("seed vcluster destroy job: %w", err)
	}
	return jobID, nil
}
