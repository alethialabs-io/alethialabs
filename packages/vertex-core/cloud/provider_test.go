// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/types"
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

func TestAWSProvider_RequiredCLIs(t *testing.T) {
	p := &awsProvider{}
	clis := p.RequiredCLIs()
	expected := map[string]bool{"aws-iam-authenticator": true, "kubectl": true, "helm": true}
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

func TestGCPProvider_ProviderTfvars(t *testing.T) {
	p := &gcpProvider{}
	vc := &types.VineConfig{
		ProjectName:      "test-gcp",
		Region:           "us-central1",
		EnvironmentStage: "staging",
		CloudAccountID:   "my-gcp-project",
		Network: types.VineNetworkConfig{
			ProvisionNetwork: true,
			CIDRBlock:        "10.0.0.0/16",
			SingleNatGateway: true,
		},
		Cluster: types.VineClusterConfig{
			ClusterVersion: "1.31",
			InstanceTypes:  []string{"e2-standard-4"},
			NodeMinSize:    2,
			NodeMaxSize:    5,
			NodeDesiredSize: 3,
			ProviderConfig: map[string]any{"enable_autopilot": true},
		},
		DNS: types.VineDNSConfig{
			Enabled:    true,
			DomainName: "example.com",
			ZoneID:     "my-zone",
			ProviderConfig: map[string]any{
				"cloud_armor":        true,
				"managed_certificate": true,
			},
		},
		Databases: []types.VineDatabaseConfig{
			{Name: "main", Engine: "aurora-postgresql", EngineVersion: "16", Port: intPtr(5432)},
		},
		Caches: []types.VineCacheConfig{
			{Name: "redis"},
		},
		Secrets: []types.VineSecretConfig{
			{Name: "api-key", Generate: true, Length: 32, SpecialChars: true},
		},
	}

	tfvars := p.ProviderTfvars(vc)

	if tfvars["project_id"] != "my-gcp-project" {
		t.Errorf("project_id = %v", tfvars["project_id"])
	}
	if tfvars["region"] != "us-central1" {
		t.Errorf("region = %v", tfvars["region"])
	}
	if tfvars["provision_network"] != true {
		t.Errorf("provision_network = %v", tfvars["provision_network"])
	}
	if tfvars["gke_cluster_version"] != "1.31" {
		t.Errorf("gke_cluster_version = %v", tfvars["gke_cluster_version"])
	}
	if tfvars["gke_enable_autopilot"] != true {
		t.Errorf("gke_enable_autopilot = %v", tfvars["gke_enable_autopilot"])
	}
	if tfvars["create_cloud_sql"] != true {
		t.Errorf("expected create_cloud_sql=true")
	}
	if tfvars["cloud_sql_engine"] != "POSTGRES" {
		t.Errorf("cloud_sql_engine = %v", tfvars["cloud_sql_engine"])
	}
	if tfvars["create_memorystore"] != true {
		t.Errorf("expected create_memorystore=true")
	}
	if tfvars["cloud_armor_enabled"] != true {
		t.Errorf("expected cloud_armor_enabled=true")
	}
	if tfvars["single_cloud_nat"] != true {
		t.Errorf("single_cloud_nat = %v", tfvars["single_cloud_nat"])
	}
	secrets, ok := tfvars["custom_secrets"].([]map[string]interface{})
	if !ok || len(secrets) != 1 {
		t.Errorf("custom_secrets unexpected: %v", tfvars["custom_secrets"])
	}
}

func TestAzureProvider_ProviderTfvars(t *testing.T) {
	p := &azureProvider{}
	vc := &types.VineConfig{
		ProjectName:      "test-azure",
		Region:           "westeurope",
		EnvironmentStage: "production",
		CloudAccountID:   "sub-12345",
		Network: types.VineNetworkConfig{
			ProvisionNetwork: true,
			CIDRBlock:        "10.0.0.0/16",
		},
		Cluster: types.VineClusterConfig{
			ClusterVersion: "1.31",
			InstanceTypes:  []string{"Standard_D4s_v3"},
			NodeMinSize:    2,
			NodeMaxSize:    5,
			NodeDesiredSize: 3,
			ProviderConfig: map[string]any{},
		},
		DNS: types.VineDNSConfig{
			Enabled:    true,
			DomainName: "example.com",
			ProviderConfig: map[string]any{
				"azure_waf": true,
			},
		},
		Databases: []types.VineDatabaseConfig{
			{Name: "main", Engine: "mysql", EngineVersion: "8.0", Port: intPtr(3306)},
		},
		Queues: []types.VineQueueConfig{
			{Name: "events"},
		},
		Topics: []types.VineTopicConfig{
			{Name: "notifications"},
		},
	}

	tfvars := p.ProviderTfvars(vc)

	if tfvars["subscription_id"] != "sub-12345" {
		t.Errorf("subscription_id = %v", tfvars["subscription_id"])
	}
	if tfvars["location"] != "westeurope" {
		t.Errorf("location = %v", tfvars["location"])
	}
	if tfvars["provision_vnet"] != true {
		t.Errorf("provision_vnet = %v", tfvars["provision_vnet"])
	}
	if tfvars["aks_cluster_version"] != "1.31" {
		t.Errorf("aks_cluster_version = %v", tfvars["aks_cluster_version"])
	}
	if tfvars["create_azure_db"] != true {
		t.Errorf("expected create_azure_db=true")
	}
	if tfvars["azure_db_engine"] != "mysql" {
		t.Errorf("azure_db_engine = %v", tfvars["azure_db_engine"])
	}
	if tfvars["create_service_bus"] != true {
		t.Errorf("expected create_service_bus=true")
	}
	if tfvars["azure_waf_enabled"] != true {
		t.Errorf("expected azure_waf_enabled=true")
	}
	if tfvars["azure_dns_enabled"] != true {
		t.Errorf("expected azure_dns_enabled=true")
	}
}

func TestExtractClusterName_MultiProvider(t *testing.T) {
	tests := []struct {
		name    string
		outputs map[string]interface{}
		want    string
	}{
		{
			name:    "GKE cluster",
			outputs: map[string]interface{}{"gke_cluster_name": map[string]interface{}{"value": "gke-cluster"}},
			want:    "gke-cluster",
		},
		{
			name:    "AKS cluster",
			outputs: map[string]interface{}{"aks_cluster_name": "aks-cluster"},
			want:    "aks-cluster",
		},
		{
			name:    "EKS takes priority",
			outputs: map[string]interface{}{"eks_cluster_name": "eks-first", "gke_cluster_name": "gke-second"},
			want:    "eks-first",
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

func TestExtractClusterEndpoint(t *testing.T) {
	tests := []struct {
		name    string
		outputs map[string]interface{}
		want    string
	}{
		{
			name:    "GKE endpoint",
			outputs: map[string]interface{}{"gke_cluster_endpoint": map[string]interface{}{"value": "https://gke.example.com"}},
			want:    "https://gke.example.com",
		},
		{
			name:    "AKS endpoint",
			outputs: map[string]interface{}{"aks_cluster_endpoint": "https://aks.example.com"},
			want:    "https://aks.example.com",
		},
		{
			name:    "missing",
			outputs: map[string]interface{}{},
			want:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractClusterEndpoint(tt.outputs)
			if got != tt.want {
				t.Errorf("ExtractClusterEndpoint() = %q, want %q", got, tt.want)
			}
		})
	}
}

func floatPtr(f float64) *float64 { return &f }
func intPtr(i int) *int           { return &i }
