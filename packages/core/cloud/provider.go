// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type CloudProvider interface {
	Name() string
	RequiredCLIs() []string
	ProviderTfvars(config *types.ProjectConfig) map[string]interface{}
	ConfigureKubeconfig(ctx context.Context, config *types.ProjectConfig, outputs map[string]interface{}, stdout io.Writer) error
}

func NewCloudProvider(provider string) (CloudProvider, error) {
	// Switch on types.CloudProvider so `exhaustive` forces a case for every cloud_provider
	// value — adding a cloud to the enum SSOT makes wiring it here (or explicitly marking it
	// "coming soon") mandatory, and removing one is a compile error.
	switch types.CloudProvider(provider) {
	case types.CloudProviderAws:
		return &awsProvider{}, nil
	case types.CloudProviderGcp:
		return &gcpProvider{}, nil
	case types.CloudProviderAzure:
		return &azureProvider{}, nil
	case types.CloudProviderHetzner:
		// Self-managed Talos Linux Kubernetes on cheap Hetzner Cloud VMs.
		return &hetznerProvider{}, nil
	case types.CloudProviderAlibaba:
		// Full managed stack (ACK + ApsaraDB / Redis / MNS / Tablestore / OSS / KMS / DNS).
		return &alibabaProvider{}, nil
	case types.CloudProviderDigitalocean, types.CloudProviderCivo:
		// Connectable today (identity + connection test); OpenTofu provisioning
		// templates land in a later pass.
		return nil, fmt.Errorf("provisioning for %s is coming soon (the account can be connected, but clusters can't be provisioned on it yet)", provider)
	default:
		return nil, fmt.Errorf("unsupported cloud provider: %s", provider)
	}
}

// ExtractClusterName reads the K8s cluster name from OpenTofu outputs. It prefers the
// provider-prefixed keys the managed templates emit; when none is present it falls back
// to the generic `cluster_name` key. That generic fallback is the BYO-IaC output contract
// (documented in bring-your-own-iac.mdx): a customer's own module names its output
// `cluster_name`, and without this fallback ExtractClusterName returned "" for it — which
// silently skipped kubeconfig, reachability, ArgoCD and every add-on while the deploy still
// reported success. Provider-prefixed keys stay FIRST so managed templates are unchanged.
func ExtractClusterName(outputs map[string]interface{}) string {
	keys := []string{"eks_cluster_name", "gke_cluster_name", "aks_cluster_name", "talos_cluster_name", "ack_cluster_name"}
	for _, key := range keys {
		if v := extractOutputString(outputs, key); v != "" {
			return v
		}
	}
	// BYO-IaC generic fallback.
	return extractOutputString(outputs, "cluster_name")
}

// ExtractClusterEndpoint reads the K8s cluster endpoint from OpenTofu outputs. Like
// ExtractClusterName it prefers the provider-prefixed keys and falls back to the generic
// `cluster_endpoint` key that a BYO-IaC module emits.
func ExtractClusterEndpoint(outputs map[string]interface{}) string {
	keys := []string{"eks_cluster_endpoint", "gke_cluster_endpoint", "aks_cluster_endpoint", "talos_cluster_endpoint", "ack_cluster_endpoint"}
	for _, key := range keys {
		if v := extractOutputString(outputs, key); v != "" {
			return v
		}
	}
	// BYO-IaC generic fallback.
	return extractOutputString(outputs, "cluster_endpoint")
}
