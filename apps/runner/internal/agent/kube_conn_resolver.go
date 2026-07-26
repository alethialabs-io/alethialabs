// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// newKubeConnResolver returns the runner's implementation of provisioner.KubeConnResolver: it resolves
// an EXISTING shared-Fabric cluster's control-plane endpoint + CA OUTPUT-FREE (by name, from the cloud
// API) for a `namespace`/`vcluster` placement that runs no tofu. The runner owns this because it holds
// the per-cloud keyless token minters (kube_token.go) and calls the stdlib resolvers in
// packages/core/cloud — which keeps the gcp/azure/alibaba auth SDKs OUT of packages/core (the mint path
// there stays SDK-free and just consumes the returned endpoint+CA under the provider's output keys).
//
// aws never reaches this resolver: its ConfigureKubeconfig resolves endpoint/CA via EKS DescribeCluster
// from the cluster name using the AWS SDK already in packages/core (its provider is absent from
// namespaceClusterConnKeys, so mintClusterOutputs skips the resolver for it).
func newKubeConnResolver() provisioner.KubeConnResolver {
	return func(ctx context.Context, providerSlug string, config *types.ProjectConfig, clusterName string) (string, string, error) {
		switch providerSlug {
		case "gcp":
			return resolveGKEConn(ctx, config, clusterName)
		default:
			// azure/alibaba are per-cloud follow-ups; hetzner-talos is a permanent exclusion (no cloud
			// API to re-mint). Fail closed rather than return an empty conn (which would silently
			// produce an unusable kubeconfig downstream). selectPlacementPath + the *RemintProviders
			// allowlists already gate this; this is defence-in-depth.
			return "", "", fmt.Errorf("kube-conn resolver: no output-free resolver is wired for provider %q — a namespace/vcluster placement on it is not activated", providerSlug)
		}
	}
}

// resolveGKEConn resolves a GKE cluster's control-plane endpoint + base64 CA BY NAME via the keyless WIF
// OAuth token (mintGCPToken) and the GKE clusters.get REST call (cloud.ResolveGKEClusterConn). The token
// is cloud-platform-scoped (permits container.clusters.get) and is sent as a bearer, never logged.
//
//	project  = config.CloudAccountID — the tenant's GCP project (the shared Fabric lives in it).
//	location = config.Region         — the placed env resolves onto the Fabric's cluster, which is in
//	                                   this region. NB regional GKE only; a zonal Fabric would need its
//	                                   zone as the location (managed Fabrics are regional today).
func resolveGKEConn(ctx context.Context, config *types.ProjectConfig, clusterName string) (string, string, error) {
	token, _, err := mintGCPToken(ctx)
	if err != nil {
		return "", "", fmt.Errorf("mint GCP token for kube-conn resolve: %w", err)
	}
	conn, err := cloud.ResolveGKEClusterConn(ctx, nil, token, config.CloudAccountID, config.Region, clusterName)
	if err != nil {
		return "", "", err
	}
	return conn.Endpoint, conn.CAData, nil
}
