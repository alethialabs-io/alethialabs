// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// These tests exist because of a specific failure: argocd.NamespaceTenantInput.AppsPath and
// VClusterAppInput.AppsPath existed, rendered and defaulted correctly for months — and NOTHING EVER
// SET THEM. A placed environment silently synced the repository root, so per-tier Kustomize overlays
// could not reach a placement at all. Render-level tests could not catch it: the renderer was always
// right. The gap was in the dispatch, so that is where these assert.

func appsPathTestConfig(mode types.PlacementMode) *types.ProjectConfig {
	vc := &types.ProjectConfig{
		ProjectName:   "acme",
		Namespace:     "team-web",
		PlacementMode: mode,
	}
	vc.Cluster.ClusterName = "acme-prod-cluster"
	vc.Repositories.AppsDestinationRepo = "https://github.com/acme/manifests"
	return vc
}

// TestNamespaceTenantInputCarriesAppsPath is the test that would have caught the original gap.
func TestNamespaceTenantInputCarriesAppsPath(t *testing.T) {
	t.Run("threads the configured overlay", func(t *testing.T) {
		vc := appsPathTestConfig(types.PlacementModeNamespace)
		vc.Repositories.AppsPath = "overlays/dev"
		if got := namespaceTenantInput(vc, "boutique-dev").AppsPath; got != "overlays/dev" {
			t.Fatalf("AppsPath = %q, want overlays/dev — an unthreaded path means the placement delivers the whole repo", got)
		}
	})

	t.Run("unset still renders the repo root", func(t *testing.T) {
		vc := appsPathTestConfig(types.PlacementModeNamespace)
		out, err := argocd.RenderNamespaceTenant(namespaceTenantInput(vc, "boutique-dev"))
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		if !strings.Contains(out.App, "path: '.'") {
			t.Fatalf("an unset apps_path must render the repo root, preserving every pre-existing placement:\n%s", out.App)
		}
	})
}

func TestVClusterAppInputCarriesAppsPath(t *testing.T) {
	t.Run("threads the configured overlay", func(t *testing.T) {
		vc := appsPathTestConfig(types.PlacementModeVcluster)
		vc.Repositories.AppsPath = "overlays/staging"
		if got := vclusterAppInput(vc, "tenant-vc", "workload").AppsPath; got != "overlays/staging" {
			t.Fatalf("AppsPath = %q, want overlays/staging", got)
		}
	})

	t.Run("unset still renders the repo root", func(t *testing.T) {
		vc := appsPathTestConfig(types.PlacementModeVcluster)
		out, err := argocd.RenderVClusterApp(vclusterAppInput(vc, "tenant-vc", "workload"))
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		if !strings.Contains(out.App, "path: '.'") {
			t.Fatalf("an unset apps_path must render the repo root:\n%s", out.App)
		}
	})
}

// TestAppsPathFailsClosedBeforeAnyClusterWork proves the guard sits ABOVE the dry-run short-circuit.
// That placement is deliberate and is what makes this test hermetic: by the time the renderer would
// reject a hostile path, the runner has already minted kube access, probed the cluster and (for
// vcluster) helm-installed a virtual control plane on the shared Fabric. Rejecting at render time
// would be correct but far too late.
func TestAppsPathFailsClosedBeforeAnyClusterWork(t *testing.T) {
	hostile := []string{"../../etc", "/abs/path", "overlays/../../etc", "over'lays", "$(whoami)"}

	t.Run("namespace", func(t *testing.T) {
		for _, p := range hostile {
			t.Run(p, func(t *testing.T) {
				vc := appsPathTestConfig(types.PlacementModeNamespace)
				vc.Repositories.AppsPath = p
				var out, errOut strings.Builder
				_, err := runNamespaceDeploy(t.Context(), DeployParams{
					ProjectConfig: vc, Provider: "aws", DryRun: true, Stdout: &out, Stderr: &errOut,
				})
				if err == nil {
					t.Fatalf("apps path %q was accepted — a hostile path must fail before any cluster is touched", p)
				}
				if !strings.Contains(err.Error(), "apps path") {
					t.Errorf("error should name the offending input, got %q", err.Error())
				}
			})
		}
	})

	t.Run("vcluster", func(t *testing.T) {
		for _, p := range hostile {
			t.Run(p, func(t *testing.T) {
				vc := appsPathTestConfig(types.PlacementModeVcluster)
				vc.Repositories.AppsPath = p
				var out, errOut strings.Builder
				_, err := runVClusterDeploy(t.Context(), DeployParams{
					ProjectConfig: vc, Provider: "aws", DryRun: true, Stdout: &out, Stderr: &errOut,
				})
				if err == nil {
					t.Fatalf("apps path %q was accepted", p)
				}
				if !strings.Contains(err.Error(), "apps path") {
					t.Errorf("error should name the offending input, got %q", err.Error())
				}
			})
		}
	})
}

// TestValidAppsPathDoesNotBreakThePlanPath is the companion refuter: the guard must reject hostile
// input WITHOUT breaking the ordinary plan for a legitimate overlay.
func TestValidAppsPathDoesNotBreakThePlanPath(t *testing.T) {
	for _, mode := range []types.PlacementMode{types.PlacementModeNamespace, types.PlacementModeVcluster} {
		t.Run(string(mode), func(t *testing.T) {
			vc := appsPathTestConfig(mode)
			vc.Repositories.AppsPath = "overlays/dev"
			var out, errOut strings.Builder
			params := DeployParams{ProjectConfig: vc, Provider: "aws", DryRun: true, Stdout: &out, Stderr: &errOut}

			var err error
			if mode == types.PlacementModeNamespace {
				_, err = runNamespaceDeploy(t.Context(), params)
			} else {
				_, err = runVClusterDeploy(t.Context(), params)
			}
			if err != nil {
				t.Fatalf("a valid overlay path must plan cleanly, got: %v", err)
			}
		})
	}
}
