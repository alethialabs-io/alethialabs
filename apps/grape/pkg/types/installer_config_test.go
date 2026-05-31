package types

import (
	"testing"

	"gopkg.in/yaml.v3"
)

func TestInstallerConfigYAMLRoundTrip(t *testing.T) {
	boolTrue := true
	minSize := 3

	config := InstallerConfig{
		ProjectName:  "test-project",
		Region:       "eu-west-1",
		Environment:  "dev",
		AwsAccountID: "123456789012",
		TerraformVer: "1.11.4",
		EnvTemplateRepo:       "git@github.com:itgix/adp-tf-envtempl-standard.git",
		EnvTemplateRepoBranch: "v1.2.7",
		EnvGitRepo:            "git@github.com:user/env.git",
		GitopsTemplateRepo:    "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git",
		GitopsDestinationRepo: "https://github.com/user/gitops.git",
		ProvisionVPC:          &boolTrue,
		VPCCIDR:               "10.0.0.0/16",
		EKSNgMinSize:          &minSize,
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var parsed InstallerConfig
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if parsed.ProjectName != "test-project" {
		t.Errorf("expected project_name 'test-project', got %q", parsed.ProjectName)
	}
	if parsed.Region != "eu-west-1" {
		t.Errorf("expected region 'eu-west-1', got %q", parsed.Region)
	}
	if parsed.VPCCIDR != "10.0.0.0/16" {
		t.Errorf("expected vpc_cidr '10.0.0.0/16', got %q", parsed.VPCCIDR)
	}
	if parsed.EKSNgMinSize == nil || *parsed.EKSNgMinSize != 3 {
		t.Error("expected eks_ng_min_size 3")
	}
}

func TestInstallerConfigOptionalFieldsDefault(t *testing.T) {
	yamlStr := `
project_name: "minimal"
region: "us-east-1"
environment: "prod"
aws_account_id: "111222333444"
terraform_ver: "1.11.4"
env_template_repo: "git@github.com:org/repo.git"
env_template_repo_branch: "main"
env_git_repo: "git@github.com:org/env.git"
gitops_template_repo: "git@github.com:org/gitops.git"
gitops_destination_repo: "https://github.com/org/dest.git"
`
	var config InstallerConfig
	if err := yaml.Unmarshal([]byte(yamlStr), &config); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if config.ProvisionVPC != nil {
		t.Error("expected provision_vpc to be nil when not set")
	}
	if config.CreateRDS != nil {
		t.Error("expected create_rds to be nil when not set")
	}
	if config.EKSClusterVersion != "" {
		t.Errorf("expected empty eks_cluster_version, got %q", config.EKSClusterVersion)
	}
}

func TestEKSClusterAdminParsing(t *testing.T) {
	yamlStr := `
project_name: "test"
region: "eu-west-1"
environment: "dev"
aws_account_id: "123456789012"
terraform_ver: "1.11.4"
env_template_repo: "git@github.com:org/repo.git"
env_template_repo_branch: "main"
env_git_repo: "git@github.com:org/env.git"
gitops_template_repo: "git@github.com:org/gitops.git"
gitops_destination_repo: "https://github.com/org/dest.git"
eks_cluster_admins:
  - username: "admin@corp.com"
    path: "/"
  - username: "dev@corp.com"
    path: "/devs/"
`
	var config InstallerConfig
	if err := yaml.Unmarshal([]byte(yamlStr), &config); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if len(config.EKSClusterAdmins) != 2 {
		t.Fatalf("expected 2 admins, got %d", len(config.EKSClusterAdmins))
	}
	if config.EKSClusterAdmins[0].Username != "admin@corp.com" {
		t.Errorf("expected first admin username 'admin@corp.com', got %q", config.EKSClusterAdmins[0].Username)
	}
	if config.EKSClusterAdmins[1].Path != "/devs/" {
		t.Errorf("expected second admin path '/devs/', got %q", config.EKSClusterAdmins[1].Path)
	}
}
