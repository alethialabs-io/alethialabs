// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestInspectClusterNoClusterName(t *testing.T) {
	// No provisioned cluster name → nothing to inspect (returns all nil, never panics).
	vc := &types.ProjectConfig{}
	addon, sec, gitops := InspectCluster(context.Background(), vc, "aws", nil, io.Discard, io.Discard)
	if addon != nil || sec != nil || gitops != nil {
		t.Errorf("expected (nil, nil, nil) without a cluster name, got (%v, %v, %v)", addon, sec, gitops)
	}
}

func TestInspectClusterNilConfig(t *testing.T) {
	addon, sec, gitops := InspectCluster(context.Background(), nil, "aws", nil, io.Discard, io.Discard)
	if addon != nil || sec != nil || gitops != nil {
		t.Errorf("expected (nil, nil, nil) for a nil config, got (%v, %v, %v)", addon, sec, gitops)
	}
}

// Hetzner (and alibaba) kubeconfig acquisition needs the sensitive `kubeconfig` tofu
// output — with the drift run's outputs provided, inspection proceeds past kubeconfig;
// without them it must skip cleanly instead of failing the day-2 job.
func TestInspectClusterHetznerOutputsFedKubeconfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KUBECONFIG", "")

	vc := &types.ProjectConfig{}
	vc.Cluster.ClusterName = "talos-demo"

	// No outputs → the synthesized cluster-name map has no kubeconfig → clean skip.
	addon, sec, gitops := InspectCluster(context.Background(), vc, "hetzner", nil, io.Discard, io.Discard)
	if addon != nil || sec != nil || gitops != nil {
		t.Errorf("expected (nil, nil, nil) on hetzner without outputs, got (%v, %v, %v)", addon, sec, gitops)
	}

	// Drift outputs carry the kubeconfig → inspection reaches the probe stage (the
	// security probe is best-effort against an unreachable cluster, but non-nil).
	outputs := map[string]interface{}{
		"kubeconfig": "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n",
	}
	_, sec, gitops = InspectCluster(context.Background(), vc, "hetzner", outputs, io.Discard, io.Discard)
	if sec == nil {
		t.Fatalf("expected inspection to proceed with an outputs-fed kubeconfig")
	}
	// No apps repo configured → the day-2 snapshot honestly reports direct mode.
	if gitops == nil || gitops.Mode != "direct" {
		t.Errorf("expected a direct-mode gitops snapshot, got %+v", gitops)
	}
}

func TestClusterNameOutputKey(t *testing.T) {
	cases := map[string]string{
		"aws":     "eks_cluster_name",
		"gcp":     "gke_cluster_name",
		"azure":   "aks_cluster_name",
		"alibaba": "ack_cluster_name",
		"hetzner": "talos_cluster_name",
		"unknown": "eks_cluster_name", // default
	}
	for provider, want := range cases {
		if got := clusterNameOutputKey(provider); got != want {
			t.Errorf("clusterNameOutputKey(%q) = %q, want %q", provider, got, want)
		}
	}
}

// The synthesized single-key outputs map InspectCluster builds must round-trip through
// cloud.ExtractClusterName for every provisionable cloud — a key drift here silently
// kills the day-2 addon-health/security refresh (the #312-style parity guard).
func TestClusterNameOutputKeyRoundTripsExtract(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		outputs := map[string]interface{}{clusterNameOutputKey(provider): "cluster-x"}
		if got := cloud.ExtractClusterName(outputs); got != "cluster-x" {
			t.Errorf("provider %q: ExtractClusterName over %q = %q, want cluster-x",
				provider, clusterNameOutputKey(provider), got)
		}
	}
}
