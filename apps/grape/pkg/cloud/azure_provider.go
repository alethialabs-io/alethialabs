package cloud

import (
	"context"
	"fmt"
	"io"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
)

type azureProvider struct{}

func (p *azureProvider) Name() string { return "azure" }

func (p *azureProvider) RequiredCLIs() []string {
	return []string{"az", "kubectl", "helm"}
}

func (p *azureProvider) BackendConfig(projectName, environment, region string) map[string]string {
	return map[string]string{
		"resource_group_name":  fmt.Sprintf("%s-%s-tf-state-rg", projectName, environment),
		"storage_account_name": fmt.Sprintf("%s%stfstate", projectName, environment),
		"container_name":       "tfstate",
		"key":                  fmt.Sprintf("%s-%s-%s.tfstate", projectName, environment, region),
	}
}

func (p *azureProvider) ProviderTfvars(config *types.VineConfig) map[string]interface{} {
	tfvars := map[string]interface{}{
		"project_name": config.ProjectName,
		"location":     config.Region,
		"environment":  config.EnvironmentStage,
	}

	if config.Network.CIDRBlock != "" {
		tfvars["vnet_cidr"] = config.Network.CIDRBlock
	}
	if config.Cluster.ClusterVersion != "" {
		tfvars["aks_cluster_version"] = config.Cluster.ClusterVersion
	}

	return tfvars
}

func (p *azureProvider) ConfigureKubeconfig(ctx context.Context, clusterName, region string, stdout io.Writer) error {
	return fmt.Errorf("Azure kubeconfig configuration not yet implemented")
}

var _ CloudProvider = (*azureProvider)(nil)
