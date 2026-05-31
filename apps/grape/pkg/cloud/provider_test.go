package cloud

import (
	"testing"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
)

func TestNewCloudProvider(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		wantName string
		wantErr  bool
	}{
		{"aws", "aws", "aws", false},
		{"gcp", "gcp", "gcp", false},
		{"azure", "azure", "azure", false},
		{"unknown", "digitalocean", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := NewCloudProvider(tt.provider)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if p.Name() != tt.wantName {
				t.Errorf("Name() = %q, want %q", p.Name(), tt.wantName)
			}
		})
	}
}

func TestAWSProvider_BackendConfig(t *testing.T) {
	p := &awsProvider{}
	cfg := p.BackendConfig("myproject", "dev", "eu-west-1")

	if cfg["bucket"] != "myproject-dev-eu-west-1-idp-state" {
		t.Errorf("unexpected bucket: %s", cfg["bucket"])
	}
	if cfg["key"] != "myproject-dev-eu-west-1-terraform.tfstate" {
		t.Errorf("unexpected key: %s", cfg["key"])
	}
	if cfg["region"] != "eu-west-1" {
		t.Errorf("unexpected region: %s", cfg["region"])
	}
}

func TestAWSProvider_RequiredCLIs(t *testing.T) {
	p := &awsProvider{}
	clis := p.RequiredCLIs()
	expected := map[string]bool{"aws": true, "kubectl": true, "helm": true}
	for _, cli := range clis {
		if !expected[cli] {
			t.Errorf("unexpected CLI: %s", cli)
		}
	}
	if len(clis) != 3 {
		t.Errorf("expected 3 CLIs, got %d", len(clis))
	}
}

func TestAWSProvider_ProviderTfvars(t *testing.T) {
	p := &awsProvider{}
	vc := &types.VineConfig{
		ProjectName:      "test",
		Region:           "us-east-1",
		EnvironmentStage: "prod",
		TerraformVersion: "1.11.4",
		Network: types.VineNetworkConfig{
			ProvisionNetwork: true,
			CIDRBlock:        "10.0.0.0/16",
		},
		Cluster: types.VineClusterConfig{
			ClusterVersion: "1.30",
			ProviderConfig: map[string]any{"enable_karpenter": true},
		},
		DNS: types.VineDNSConfig{
			Enabled:    true,
			DomainName: "example.com",
			ZoneID:     "Z123",
			ProviderConfig: map[string]any{
				"acm_certificate": true,
				"cloudfront_waf":  true,
			},
		},
		Databases: []types.VineDatabaseConfig{
			{Name: "main", MinCapacity: floatPtr(0.5), MaxCapacity: floatPtr(4.0)},
		},
		Caches: []types.VineCacheConfig{
			{Name: "redis", NodeType: "cache.t3.micro"},
		},
	}

	tfvars := p.ProviderTfvars(vc)

	if tfvars["project_name"] != "test" {
		t.Errorf("project_name = %v", tfvars["project_name"])
	}
	if tfvars["region"] != "us-east-1" {
		t.Errorf("region = %v", tfvars["region"])
	}
	if tfvars["provision_vpc"] != true {
		t.Errorf("provision_vpc = %v", tfvars["provision_vpc"])
	}
	if tfvars["vpc_cidr"] != "10.0.0.0/16" {
		t.Errorf("vpc_cidr = %v", tfvars["vpc_cidr"])
	}
	if tfvars["eks_cluster_version"] != "1.30" {
		t.Errorf("eks_cluster_version = %v", tfvars["eks_cluster_version"])
	}
	if tfvars["create_rds"] != true {
		t.Errorf("expected create_rds=true")
	}
	if tfvars["create_elasticache_redis"] != true {
		t.Errorf("expected create_elasticache_redis=true")
	}
}

func TestGCPProvider_BackendConfig(t *testing.T) {
	p := &gcpProvider{}
	cfg := p.BackendConfig("myproject", "staging", "us-central1")

	if cfg["bucket"] != "myproject-staging-us-central1-tf-state" {
		t.Errorf("unexpected bucket: %s", cfg["bucket"])
	}
	if cfg["prefix"] != "myproject-staging-us-central1" {
		t.Errorf("unexpected prefix: %s", cfg["prefix"])
	}
}

func TestAzureProvider_BackendConfig(t *testing.T) {
	p := &azureProvider{}
	cfg := p.BackendConfig("myproject", "prod", "eastus")

	if cfg["resource_group_name"] != "myproject-prod-tf-state-rg" {
		t.Errorf("unexpected resource_group_name: %s", cfg["resource_group_name"])
	}
	if cfg["key"] != "myproject-prod-eastus.tfstate" {
		t.Errorf("unexpected key: %s", cfg["key"])
	}
}

func TestExtractClusterName(t *testing.T) {
	tests := []struct {
		name    string
		outputs map[string]interface{}
		want    string
	}{
		{
			name:    "nested value",
			outputs: map[string]interface{}{"eks_cluster_name": map[string]interface{}{"value": "my-cluster"}},
			want:    "my-cluster",
		},
		{
			name:    "flat string",
			outputs: map[string]interface{}{"eks_cluster_name": "flat-cluster"},
			want:    "flat-cluster",
		},
		{
			name:    "missing",
			outputs: map[string]interface{}{"other_key": "val"},
			want:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractClusterName(tt.outputs)
			if got != tt.want {
				t.Errorf("ExtractClusterName() = %q, want %q", got, tt.want)
			}
		})
	}
}

func floatPtr(f float64) *float64 { return &f }
