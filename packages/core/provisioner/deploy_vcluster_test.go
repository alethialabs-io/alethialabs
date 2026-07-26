// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestBuildVClusterSpec locks the per-env name derivation off the env's namespace (relocated from the
// runner's BuildVClusterSpec test).
func TestBuildVClusterSpec(t *testing.T) {
	vc := &types.ProjectConfig{
		ProjectName:   "acme",
		Namespace:     "team-web",
		PlacementMode: types.PlacementModeVcluster,
	}
	spec, err := buildVClusterSpec(vc)
	if err != nil {
		t.Fatalf("buildVClusterSpec: %v", err)
	}
	if spec.Name != "team-web" {
		t.Errorf("Name = %q, want team-web", spec.Name)
	}
	if spec.HostNamespace != "vcluster-team-web" {
		t.Errorf("HostNamespace = %q, want vcluster-team-web", spec.HostNamespace)
	}
	if spec.ServiceAccount != "vcluster-argocd-team-web" {
		t.Errorf("ServiceAccount = %q", spec.ServiceAccount)
	}
	if spec.KubeconfigSecret != "vcluster-kubeconfig-team-web" {
		t.Errorf("KubeconfigSecret = %q", spec.KubeconfigSecret)
	}
	if spec.KubeconfigNamespace != "argocd" {
		t.Errorf("KubeconfigNamespace = %q, want argocd", spec.KubeconfigNamespace)
	}
	if err := spec.Validate(); err != nil {
		t.Errorf("built spec is invalid: %v", err)
	}
}

// TestBuildVClusterSpecFailsClosed covers the fail-closed branches (relocated from the runner test).
func TestBuildVClusterSpecFailsClosed(t *testing.T) {
	if _, err := buildVClusterSpec(nil); err == nil {
		t.Error("nil config: expected error, got nil")
	}
	if _, err := buildVClusterSpec(&types.ProjectConfig{Namespace: ""}); err == nil {
		t.Error("empty namespace: expected error, got nil")
	}
	// A namespace that isn't a valid DNS-1123 label must fail closed (it flows into helm/kubectl).
	if _, err := buildVClusterSpec(&types.ProjectConfig{Namespace: "Bad NS"}); err == nil {
		t.Error("invalid namespace: expected validation error, got nil")
	}
	// A namespace long enough that a prefixed derived name blows past the 63-char DNS-1123 limit.
	long := strings.Repeat("a", 60)
	if _, err := buildVClusterSpec(&types.ProjectConfig{Namespace: long}); err == nil {
		t.Error("over-long derived name: expected validation error, got nil")
	}
}

// TestSelectPlacementPathVcluster locks the activation gate: vcluster is routed to the vcluster path only
// on a re-mint-wired cloud (aws today) and fails closed everywhere else — cloud parity is explicit.
func TestSelectPlacementPathVcluster(t *testing.T) {
	if got := selectPlacementPath(types.PlacementModeVcluster, "aws"); got != placementVcluster {
		t.Errorf("vcluster on aws = %v, want placementVcluster", got)
	}
	for _, provider := range []string{"gcp", "azure", "alibaba", "hetzner", "hetzner-talos", ""} {
		if got := selectPlacementPath(types.PlacementModeVcluster, provider); got != placementUnactivated {
			t.Errorf("vcluster on %q = %v, want placementUnactivated (fail-closed parity)", provider, got)
		}
	}
	// Sanity: the other modes are unaffected by the new branch.
	if got := selectPlacementPath(types.PlacementModeDedicated, "aws"); got != placementDedicated {
		t.Errorf("dedicated on aws = %v, want placementDedicated", got)
	}
	if got := selectPlacementPath("", "gcp"); got != placementDedicated {
		t.Errorf("empty (legacy) on gcp = %v, want placementDedicated", got)
	}
}

// TestVClusterRemintWired locks the single activation control (aws-first, everything else fail-closed).
func TestVClusterRemintWired(t *testing.T) {
	if !vclusterRemintWired("aws") {
		t.Error("aws should be wired for vcluster re-mint")
	}
	for _, provider := range []string{"gcp", "azure", "alibaba", "hetzner", "hetzner-talos"} {
		if vclusterRemintWired(provider) {
			t.Errorf("%q must not be wired yet (parity follow-up / permanent exclusion)", provider)
		}
	}
}

// TestRunVClusterDeployDryRun verifies the plan short-circuit provisions nothing and reports the target.
func TestRunVClusterDeployDryRun(t *testing.T) {
	var out, errOut strings.Builder
	vc := &types.ProjectConfig{
		ProjectName:   "acme",
		Namespace:     "team-web",
		PlacementMode: types.PlacementModeVcluster,
	}
	vc.Cluster.ClusterName = "acme-prod-cluster"

	res, err := runVClusterDeploy(t.Context(), DeployParams{
		ProjectConfig: vc,
		Provider:      "aws",
		DryRun:        true,
		Stdout:        &out,
		Stderr:        &errOut,
	})
	if err != nil {
		t.Fatalf("dry-run: unexpected error: %v", err)
	}
	if res == nil || res.ClusterName != "team-web" {
		t.Fatalf("dry-run result = %+v, want ClusterName=team-web", res)
	}
	// A plan must not have marked the cluster ready (nothing was provisioned/probed).
	if res.ClusterReady {
		t.Error("dry-run must not mark the cluster ready")
	}
	if !strings.Contains(out.String(), "Dry-run") {
		t.Errorf("dry-run output missing plan message:\n%s", out.String())
	}
}

// TestRunVClusterDeployFailsClosed covers the pre-provision fail-closed guards (no cluster/namespace on
// the snapshot, hostile identifiers, un-wired cloud) — each returns before any helm/kubectl.
func TestRunVClusterDeployFailsClosed(t *testing.T) {
	base := func() *types.ProjectConfig {
		vc := &types.ProjectConfig{ProjectName: "acme", Namespace: "team-web", PlacementMode: types.PlacementModeVcluster}
		vc.Cluster.ClusterName = "acme-prod-cluster"
		return vc
	}
	cases := map[string]struct {
		provider string
		mutate   func(*types.ProjectConfig)
	}{
		"unwired cloud":     {"gcp", func(*types.ProjectConfig) {}},
		"no host cluster":   {"aws", func(vc *types.ProjectConfig) { vc.Cluster.ClusterName = "" }},
		"no namespace":      {"aws", func(vc *types.ProjectConfig) { vc.Namespace = "" }},
		"hostile namespace": {"aws", func(vc *types.ProjectConfig) { vc.Namespace = "Bad NS" }},
		"hostile cluster":   {"aws", func(vc *types.ProjectConfig) { vc.Cluster.ClusterName = "a;rm -rf /" }},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			vc := base()
			tc.mutate(vc)
			_, err := runVClusterDeploy(t.Context(), DeployParams{ProjectConfig: vc, Provider: tc.provider})
			if err == nil {
				t.Errorf("%s: expected a fail-closed error, got nil", name)
			}
		})
	}
}
