package cloud

import (
	"context"
	"fmt"
	"io"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
)

type gcpProvider struct{}

func (p *gcpProvider) Name() string { return "gcp" }

func (p *gcpProvider) RequiredCLIs() []string {
	return []string{"gcloud", "kubectl", "helm"}
}

func (p *gcpProvider) BackendConfig(projectName, environment, region string) map[string]string {
	return map[string]string{
		"bucket": fmt.Sprintf("%s-%s-%s-tf-state", projectName, environment, region),
		"prefix": fmt.Sprintf("%s-%s-%s", projectName, environment, region),
	}
}

func (p *gcpProvider) ProviderTfvars(config *types.VineConfig) map[string]interface{} {
	tfvars := map[string]interface{}{
		"project_name": config.ProjectName,
		"region":       config.Region,
		"environment":  config.EnvironmentStage,
	}

	if config.Network.CIDRBlock != "" {
		tfvars["network_cidr"] = config.Network.CIDRBlock
	}
	if config.Cluster.ClusterVersion != "" {
		tfvars["gke_cluster_version"] = config.Cluster.ClusterVersion
	}

	return tfvars
}

func (p *gcpProvider) ConfigureKubeconfig(ctx context.Context, clusterName, region string, stdout io.Writer) error {
	return fmt.Errorf("GCP kubeconfig configuration not yet implemented")
}

var _ CloudProvider = (*gcpProvider)(nil)
