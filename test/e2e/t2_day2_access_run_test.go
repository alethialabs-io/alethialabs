// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// DAY-2 ACCESS orchestration (FULLY-TESTED P2-E) — the e2e_t2-tagged half that drives the
// pure surface (t2_day2_access.go) against a live cluster. Invoked from
// TestT2RealCloudProvisioning AFTER the ArgoCD health assert and BEFORE the guaranteed
// teardown, reusing the SAME runner-written kubeconfig (kc) + persisted execution_metadata.
package e2e

import (
	"context"
	"os"
	"testing"
)

// day2AccessParams carries what the day-2 access assertion needs from the deploy under test.
type day2AccessParams struct {
	provider string
	metaRaw  []byte
}

// runT2Day2Access proves the SURFACED day-2 access path works (P2-E). Opt-in via
// ALETHIA_E2E_DAY2_ACCESS — unset ⇒ a clean skip (the base T2 proof is unchanged). It
// derives the access targets from the deploy's persisted metadata (fail-closed on a missing
// cluster_endpoint), then asserts: (a) the runner-written CLI-free kubeconfig AUTHENTICATES
// and is AUTHORIZED for `auth can-i '*' '*'` — distinct from the soak's unauthenticated
// /readyz — (b) a real node read via that kubeconfig, and (c) where an ingress exists (AWS)
// the ArgoCD URL resolves. A deferred writeAccessSummary persists the verdict to
// ALETHIA_E2E_DAY2_ACCESS_SUMMARY when set.
func runT2Day2Access(t *testing.T, ctx context.Context, kc string, p day2AccessParams) {
	t.Helper()
	if !Day2AccessEnabled() {
		t.Logf("day-2 access: skipped (ALETHIA_E2E_DAY2_ACCESS unset)")
		return
	}

	targets, err := deriveAccessTargets(p.metaRaw)
	if err != nil {
		t.Fatalf("day-2 access: %v\nraw metadata: %s", err, p.metaRaw)
	}
	timeout := Day2AccessTimeout()

	summary := AccessSummary{
		Enabled:          true,
		Provider:         p.provider,
		EndpointSurfaced: targets.Endpoint != "",
		Endpoint:         targets.Endpoint,
		AuthAction:       "* / *",
		ArgoURLChecked:   targets.HasArgoURL,
		ArgoURL:          targets.ArgoURL,
	}
	if path := os.Getenv("ALETHIA_E2E_DAY2_ACCESS_SUMMARY"); path != "" {
		defer func() {
			summary.Verdict = accessSummaryVerdict(summary)
			if werr := writeAccessSummary(path, summary); werr != nil {
				t.Logf("day-2 access: could not write summary to %s: %v", path, werr)
			}
		}()
	}

	t.Logf("day-2 access: cluster_endpoint surfaced (%s); proving the surfaced kubeconfig is authorized...", targets.Endpoint)

	// (a) AUTHORIZED action via the surfaced kubeconfig — the identity the kubeconfig binds
	//     (exec-plugin → kube-token) must AUTHENTICATE and be PERMITTED. This is where the
	//     "provisioned but not authorized" class (EKS access-entry #1040 / AKS AAD-admin) fails.
	reachable, authorized, aerr := probeKubeAuthorized(ctx, kc, timeout)
	summary.KubeReachable, summary.KubeAuthorized = reachable, authorized

	// (b) a real authorized cluster read via the same kubeconfig.
	nodes, nerr := probeReadyNodes(ctx, kc)
	summary.ReadyNodes = nodes

	// (c) ArgoCD URL reachability — only meaningful where an ingress exists (AWS ALB+ACM today);
	//     on gcp/azure ArgoURLChecked=false ⇒ n/a, does not gate.
	if targets.HasArgoURL {
		ok, uerr := probeArgoURL(ctx, targets.ArgoURL, timeout)
		summary.ArgoURLReachable = ok
		if uerr != nil {
			t.Logf("day-2 access: ArgoCD URL not reachable: %v", uerr)
		}
	}

	if !accessVerdictPass(summary) {
		t.Fatalf("day-2 access assertion FAILED: %s\n  kube-auth err: %v\n  node-read err: %v",
			accessSummaryVerdict(summary), aerr, nerr)
	}
	t.Logf("day-2 access proven: %s", accessSummaryVerdict(summary))
}
