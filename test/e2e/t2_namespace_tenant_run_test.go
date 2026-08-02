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

	// (7) The PER-NAMESPACE CLOUD IDENTITY is really bound — the half of the tenancy claim nothing
	//     asserted. Everything above is Kubernetes-native; without this, every tenant pod inherits
	//     the NODE's cloud credentials and one Fabric is namespaced but not genuinely multi-tenant.
	assertTenantCloudIdentity(t, ctx, kc, p.provider, ns)

	t.Logf("namespace-tenant (#959) PROVEN: app deployed into %q on the SAME cluster %q, isolation applied, per-namespace cloud identity bound, ArgoCD not reinstalled", ns, p.fabricClust)
}

// assertTenantCloudIdentity proves the tenant namespace's `default` ServiceAccount really carries
// the per-namespace cloud identity the placement minted — or, on a cloud documented as having none,
// that it carries NOTHING.
//
// The exclusion is asserted positively rather than skipped. A skip reads green whether the product
// is correct or broken, and this is exactly the assertion whose absence would let a cloud ship with
// tenant pods holding node credentials while the board stayed green.
func assertTenantCloudIdentity(t *testing.T, ctx context.Context, kc, provider, ns string) {
	t.Helper()

	binding, err := tenantIdentityForProvider(provider)
	if err != nil {
		t.Fatalf("tenant identity: %v", err)
	}

	// jsonpath needs the dots inside an annotation KEY escaped, or it reads them as traversal.
	readSA := func(field, key string) string {
		out, err := nsKubectl(ctx, kc, "get", "serviceaccount", "default", "-n", ns,
			"-o", "jsonpath={.metadata."+field+"."+strings.ReplaceAll(key, ".", `\.`)+"}")
		if err != nil {
			t.Fatalf("read default ServiceAccount %s %q in %s: %v\n%s", field, key, ns, err, out)
		}
		return strings.TrimSpace(out)
	}

	if binding.Excluded {
		// Prove the absence for every mechanism, not just this cloud's — otherwise "hetzner binds
		// nothing" would still pass if it had silently started binding an aws-shaped annotation.
		for _, other := range []string{"aws", "gcp", "azure", "alibaba"} {
			b, err := tenantIdentityForProvider(other)
			if err != nil {
				t.Fatalf("tenant identity: %v", err)
			}
			if got := readSA("annotations", b.SAAnnotation); got != "" {
				t.Fatalf("provider %q is documented as binding NO per-namespace cloud identity, but the default ServiceAccount in %q carries %s=%q — the documented exclusion is wrong, which is a finding, not a pass",
					provider, ns, b.SAAnnotation, got)
			}
		}
		t.Logf("tenant identity on %s: none by design — %s", provider, binding.Reason)
		return
	}

	ref := readSA("annotations", binding.SAAnnotation)
	if ref == "" {
		t.Fatalf("the default ServiceAccount in %q carries no %s annotation — the placement minted no per-namespace identity, so every pod in this tenant namespace falls back to the NODE's cloud credentials and the isolation is cosmetic",
			ns, binding.SAAnnotation)
	}
	if binding.SALabel != "" {
		if got := readSA("labels", binding.SALabel); got != binding.SALabelValue {
			t.Fatalf("the default ServiceAccount in %q has %s=%q, want %q — without it the webhook never injects the federated token, so the annotation above is inert",
				ns, binding.SALabel, got, binding.SALabelValue)
		}
	}
	if binding.NamespaceLabel != "" {
		out, err := nsKubectl(ctx, kc, "get", "namespace", ns,
			"-o", "jsonpath={.metadata.labels."+strings.ReplaceAll(binding.NamespaceLabel, ".", `\.`)+"}")
		if err != nil {
			t.Fatalf("read namespace label %q on %s: %v\n%s", binding.NamespaceLabel, ns, err, out)
		}
		if got := strings.TrimSpace(out); got != binding.NamespaceLabelValue {
			t.Fatalf("namespace %q has %s=%q, want %q — without it the pod-identity webhook never injects, so the SA annotation is inert",
				ns, binding.NamespaceLabel, got, binding.NamespaceLabelValue)
		}
	}

	// The other half of the isolation claim: the tenant SA must not hand its token to every pod by
	// default. The guardrail bundle sets this, and nothing asserted it either.
	// Top-level on the ServiceAccount, not under metadata.
	out, err := nsKubectl(ctx, kc, "get", "serviceaccount", "default", "-n", ns,
		"-o", "jsonpath={.automountServiceAccountToken}")
	if err != nil {
		t.Fatalf("read automountServiceAccountToken in %s: %v\n%s", ns, err, out)
	}
	if automount := strings.TrimSpace(out); automount != "false" {
		t.Fatalf("the default ServiceAccount in %q has automountServiceAccountToken=%q, want false — a tenant SA that mounts its token into every pod undoes the identity scoping just asserted", ns, automount)
	}

	t.Logf("tenant identity on %s: ns %q default SA bound via %s to %q, automount disabled", provider, ns, binding.Mechanism, ref)
}
