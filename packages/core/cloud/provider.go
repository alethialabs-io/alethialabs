// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	switch provider {
	case "aws":
		return &awsProvider{}, nil
	case "gcp":
		return &gcpProvider{}, nil
	case "azure":
		return &azureProvider{}, nil
	case "alibaba", "digitalocean", "hetzner", "civo":
		// Connectable today (identity + connection test); OpenTofu provisioning
		// templates land in a later pass.
		return nil, fmt.Errorf("provisioning for %s is coming soon (the account can be connected, but clusters can't be provisioned on it yet)", provider)
	default:
		return nil, fmt.Errorf("unsupported cloud provider: %s", provider)
	}
}

// ExtractClusterName reads the K8s cluster name from OpenTofu outputs,
// checking provider-specific output keys.
func ExtractClusterName(outputs map[string]interface{}) string {
	keys := []string{"eks_cluster_name", "gke_cluster_name", "aks_cluster_name"}
	for _, key := range keys {
		if val, ok := outputs[key]; ok {
			if m, ok := val.(map[string]interface{}); ok {
				if v, ok := m["value"].(string); ok {
					return v
				}
			}
			if s, ok := val.(string); ok {
				return s
			}
		}
	}
	return ""
}

// ExtractClusterEndpoint reads the K8s cluster endpoint from OpenTofu outputs.
func ExtractClusterEndpoint(outputs map[string]interface{}) string {
	keys := []string{"eks_cluster_endpoint", "gke_cluster_endpoint", "aks_cluster_endpoint"}
	for _, key := range keys {
		if val, ok := outputs[key]; ok {
			if m, ok := val.(map[string]interface{}); ok {
				if v, ok := m["value"].(string); ok {
					return v
				}
			}
			if s, ok := val.(string); ok {
				return s
			}
		}
	}
	return ""
}
