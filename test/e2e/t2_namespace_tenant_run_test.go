// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// Namespace-placement T2 scenario (#959) — the tagged run half. Layered onto the base T2 provision
// (t2_provision_test.go) after the cluster is up + ArgoCD Healthy, INSIDE the same ephemeral cluster
// lifetime (the base's single t.Cleanup destroys it once). Opt-in via ALETHIA_E2E_NAMESPACE_TENANT;
// aws-first (a clean skip on the other clouds, whose keyless re-mint is a follow-up). Real-apply is
// main-gated — this exercises meaningfully only from `main` (e2e-nightly).
package e2e

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// nsKubectl runs a bounded kubectl against the host-usable kubeconfig the runner wrote.
func nsKubectl(ctx context.Context, kc string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	full := append([]string{"--kubeconfig", kc}, args...)
	out, err := exec.CommandContext(cctx, "kubectl", full...).CombinedOutput()
	return string(out), err
}

// runT2NamespaceTenant drives the namespace-placement scenario: seed a second DEPLOY job onto the
// EXISTING Fabric cluster, wait SUCCESS, and assert the app landed in <ns> on the SAME cluster with
// no new cluster and no ArgoCD reinstall. The still-running base runner claims the seeded job.
func runT2NamespaceTenant(t *testing.T, ctx context.Context, cp *ControlPlane, kc string, p namespaceTenantParams) {
	if !namespaceTenantEnabled() {
		t.Log("namespace-tenant scenario (#959) disabled — set ALETHIA_E2E_NAMESPACE_TENANT=1 to run it")
		return
	}
	if p.provider != "aws" {
		t.Logf("namespace-tenant scenario is aws-first (#955) — skipped for %s", p.provider)
		return
	}

	ns := namespaceTenantSlug(p.env)
	t.Logf("namespace-tenant (#959): placing a namespace env into %q on the EXISTING Fabric cluster %q", ns, p.fabricClust)

	// Capture the argocd-server creationTimestamp BEFORE — the namespace deploy must NOT reinstall the
	// shared Fabric's ArgoCD.
	argoBefore, err := nsKubectl(ctx, kc, "get", "deployment", "argocd-server", "-n", "argocd", "-o", "jsonpath={.metadata.creationTimestamp}")
	if err != nil {
		t.Fatalf("read argocd-server before namespace deploy: %v\n%s", err, argoBefore)
	}

	// Seed the second DEPLOY job (lean/unlinked — provisioning-only; owner = the SeedRunner owner so
	// the running base runner claims it).
	snap := buildNamespaceSnapshot(p, ns)
	jobID, err := seedT2DeployJob(ctx, cp, snap, nil, p.owner)
	if err != nil {
		t.Fatalf("seed namespace DEPLOY job: %v", err)
	}
	t.Logf("seeded QUEUED namespace DEPLOY job %s (placement=namespace, cluster=%s, ns=%s)", jobID, p.fabricClust, ns)

	status, err := cp.WaitTerminal(ctx, jobID, 15*time.Minute)
	if err != nil {
		t.Fatalf("waiting for namespace job: %v", err)
	}
	if status != "SUCCESS" {
		t.Fatalf("namespace job terminal status = %q, want SUCCESS", status)
	}

	// (1) No new cluster: the namespace job reported the SAME Fabric cluster.
	_, metaRaw, err := cp.JobState(ctx, jobID)
	if err != nil {
		t.Fatalf("read namespace job metadata: %v", err)
	}
	var meta struct {
		ClusterName string `json:"cluster_name"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("decode namespace job metadata: %v\nraw: %s", err, metaRaw)
	}
	if err := namespaceClusterUnchanged(p.fabricClust, meta.ClusterName); err != nil {
		t.Fatalf("no-new-cluster assertion: %v", err)
	}

	// (2) The namespace exists with the PSA baseline enforce label (the isolation landed).
	psa, err := nsKubectl(ctx, kc, "get", "namespace", ns, "-o", `jsonpath={.metadata.labels.pod-security\.kubernetes\.io/enforce}`)
	if err != nil {
		t.Fatalf("get namespace %q: %v\n%s", ns, err, psa)
	}
	if strings.TrimSpace(psa) != "baseline" {
		t.Fatalf("namespace %q PSA enforce label = %q, want baseline (isolation not applied)", ns, strings.TrimSpace(psa))
	}

	// (3) The guardrail bundle landed in the namespace (default-deny NetworkPolicy + quota + limits).
	for _, kind := range []string{"resourcequota", "networkpolicy", "limitrange"} {
		out, err := nsKubectl(ctx, kc, "get", kind, "-n", ns, "--no-headers")
		if err != nil || strings.TrimSpace(out) == "" {
			t.Fatalf("guardrail %s missing in namespace %q: err=%v out=%q", kind, ns, err, out)
		}
	}

	// (4) The tenant app Application is routed to <ns> in-cluster and pinned to the hardened project.
	appsJSON, err := nsKubectl(ctx, kc, "get", "applications", "-n", "argocd", "-o", "json")
	if err != nil {
		t.Fatalf("list applications: %v\n%s", err, appsJSON)
	}
	app, err := findNamespaceApp([]byte(appsJSON), ns)
	if err != nil {
		t.Fatalf("namespace app routing assertion: %v", err)
	}
	t.Logf("tenant app %q routed to namespace %q (project %q, in-cluster)", app.Metadata.Name, ns, app.Spec.Project)

	// (5) The hardened AppProject is genuinely locked down (no cluster-scoped resource may be created).
	cw, err := nsKubectl(ctx, kc, "get", "appproject", app.Spec.Project, "-n", "argocd", "-o", "jsonpath={.spec.clusterResourceWhitelist}")
	if err != nil {
		t.Fatalf("get appproject %q: %v\n%s", app.Spec.Project, err, cw)
	}
	if s := strings.TrimSpace(cw); s != "" && s != "[]" {
		t.Fatalf("hardened AppProject %q clusterResourceWhitelist = %q, want empty (no cluster-scoped escape)", app.Spec.Project, s)
	}

	// (6) ArgoCD was NOT reinstalled — creationTimestamp unchanged.
	argoAfter, err := nsKubectl(ctx, kc, "get", "deployment", "argocd-server", "-n", "argocd", "-o", "jsonpath={.metadata.creationTimestamp}")
	if err != nil {
		t.Fatalf("read argocd-server after namespace deploy: %v\n%s", err, argoAfter)
	}
	if err := argocdNotReinstalled(argoBefore, argoAfter); err != nil {
		t.Fatalf("no-reinstall assertion: %v", err)
	}

	t.Logf("namespace-tenant (#959) PROVEN: app deployed into %q on the SAME cluster %q, isolation applied, ArgoCD not reinstalled", ns, p.fabricClust)
}
