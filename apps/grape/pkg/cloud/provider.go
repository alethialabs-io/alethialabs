package cloud

import (
	"context"
	"fmt"
	"io"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
)

type CloudProvider interface {
	Name() string
	RequiredCLIs() []string
	BackendConfig(projectName, environment, region string) map[string]string
	ProviderTfvars(config *types.VineConfig) map[string]interface{}
	ConfigureKubeconfig(ctx context.Context, clusterName, region string, stdout io.Writer) error
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
