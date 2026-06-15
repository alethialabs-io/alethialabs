// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
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
	ProviderTfvars(config *types.VineConfig) map[string]interface{}
	ConfigureKubeconfig(ctx context.Context, config *types.VineConfig, outputs map[string]interface{}, stdout io.Writer) error
}

func NewCloudProvider(provider string) (CloudProvider, error) {
	switch provider {
	case "aws":
		return &awsProvider{}, nil
	case "gcp":
		return &gcpProvider{}, nil
	case "azure":
		return &azureProvider{}, nil
	default:
		return nil, fmt.Errorf("unsupported cloud provider: %s", provider)
	}
}

// ExtractClusterName reads the K8s cluster name from Terraform outputs,
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

// ExtractClusterEndpoint reads the K8s cluster endpoint from Terraform outputs.
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
