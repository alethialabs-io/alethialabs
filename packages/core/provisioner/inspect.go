// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// clusterNameOutputKey is the tofu-output key each cloud's ConfigureKubeconfig reads the
// cluster name from (ExtractClusterName checks all three).
func clusterNameOutputKey(providerSlug string) string {
	switch providerSlug {
	case "gcp":
		return "gke_cluster_name"
	case "azure":
		return "aks_cluster_name"
	default:
		return "eks_cluster_name"
	}
}

// InspectCluster reads the current ArgoCD add-on health + Trivy security posture from an
// already-provisioned cluster WITHOUT a deploy — the day-2 "keep proving it" refresh. It
// acquires kubeconfig standalone from the persisted cluster name (via the cloud provider),
// then runs the same probes the deploy path uses (argocd.ReadAddOnHealth +
// argocd.ReadSecurityPosture). Best-effort by design: no cluster name, an unknown provider,
// or a kubeconfig failure returns (nil, nil) — a day-2 job (drift) must never fail because
// the cluster is briefly unreachable. Cloud creds are assumed already activated by the caller
// (the job runtime activates them before the handler runs).
func InspectCluster(
	ctx context.Context,
	vc *types.ProjectConfig,
	providerSlug string,
	stdout, stderr io.Writer,
) (map[string]argocd.AddOnHealth, *argocd.SecurityPosture) {
	if vc == nil || vc.Cluster.ClusterName == "" {
		return nil, nil
	}
	provider, err := cloud.NewCloudProvider(providerSlug)
	if err != nil {
		fmt.Fprintf(stderr, "Cluster inspection skipped: %v\n", err)
		return nil, nil
	}
	outputs := map[string]interface{}{
		clusterNameOutputKey(providerSlug): vc.Cluster.ClusterName,
	}
	if err := provider.ConfigureKubeconfig(ctx, vc, outputs, stdout); err != nil {
		fmt.Fprintf(stderr, "Cluster inspection skipped (kubeconfig): %v\n", err)
		return nil, nil
	}

	var addonStatus map[string]argocd.AddOnHealth
	if len(vc.AddOns) > 0 {
		addonStatus = argocd.ReadAddOnHealth(argocd.AllAddOnNames(vc.AddOns), stdout, stderr)
	}
	sec := argocd.ReadSecurityPosture(stdout, stderr)
	return addonStatus, &sec
}
