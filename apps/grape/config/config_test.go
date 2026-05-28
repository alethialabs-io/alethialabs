package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadInstallerConfigPreservesRawConfig(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.yaml")
	configBody := []byte(`
project_name: demo
region: eu-west-1
environment: dev
aws_account_id: "123456789012"
terraform_ver: "1.11.4"
env_template_repo: git@example.com:templates/env.git
env_template_repo_branch: main
env_git_repo: git@example.com:client/env.git
gitops_template_repo: git@example.com:templates/gitops.git
gitops_template_repo_branch: main
gitops_destination_repo: git@example.com:client/gitops.git
provision_vpc: true
rds_scaling_config:
  min_capacity: 0.5
redis_allowed_cidr_blocks:
  - 10.0.0.0/16
`)
	if err := os.WriteFile(configPath, configBody, 0644); err != nil {
		t.Fatalf("failed to write config fixture: %v", err)
	}

	installerConfig, err := LoadInstallerConfig(configPath)
	if err != nil {
		t.Fatalf("LoadInstallerConfig returned error: %v", err)
	}
	if installerConfig.Raw == nil {
		t.Fatal("expected raw config to be preserved")
	}

	configuration, err := InstallerConfigToConfiguration(installerConfig)
	if err != nil {
		t.Fatalf("InstallerConfigToConfiguration returned error: %v", err)
	}
	if configuration.ProjectName != "demo" {
		t.Fatalf("expected project name demo, got %q", configuration.ProjectName)
	}
	if configuration.FullConfig == nil {
		t.Fatal("expected full raw config JSON to be attached")
	}

	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(*configuration.FullConfig), &raw); err != nil {
		t.Fatalf("failed to decode raw config JSON: %v", err)
	}
	if _, ok := raw["rds_scaling_config"].(map[string]interface{}); !ok {
		t.Fatalf("expected nested rds_scaling_config to survive, got %#v", raw["rds_scaling_config"])
	}
}

func TestLoadFixtureConfigDemoMini(t *testing.T) {
	t.Parallel()

	cfg, err := LoadInstallerConfig("../../../spec/features/fixtures/configs/demo-mini.yml")
	if err != nil {
		t.Fatalf("failed to load demo-mini.yml: %v", err)
	}

	if err := ValidateInstallerConfig(cfg); err != nil {
		t.Fatalf("demo-mini.yml validation failed: %v", err)
	}

	if cfg.ProjectName != "adpminidemo" {
		t.Fatalf("expected project_name adpminidemo, got %q", cfg.ProjectName)
	}
	if cfg.VPCCIDR != "10.56.0.0/16" {
		t.Fatalf("expected vpc_cidr 10.56.0.0/16, got %q", cfg.VPCCIDR)
	}
	if cfg.VPCSingleNATGateway == nil || !*cfg.VPCSingleNATGateway {
		t.Fatal("expected vpc_single_nat_gateway to be true")
	}
	if len(cfg.CustomSecrets) == 0 {
		t.Fatal("expected custom_secrets to be parsed")
	}
	if cfg.EnablePrometheusStack == nil || !*cfg.EnablePrometheusStack {
		t.Fatal("expected enable_prometheus_stack to be true")
	}
	if cfg.EKSNgMinSize == nil || *cfg.EKSNgMinSize != 3 {
		t.Fatal("expected eks_ng_min_size to be 3")
	}
	if cfg.Raw == nil || len(cfg.Raw) == 0 {
		t.Fatal("expected Raw config map to be populated")
	}
}

func TestLoadFixtureConfigGda(t *testing.T) {
	t.Parallel()

	cfg, err := LoadInstallerConfig("../../../spec/features/fixtures/configs/gda-config.yaml")
	if err != nil {
		t.Fatalf("failed to load gda-config.yaml: %v", err)
	}

	if err := ValidateInstallerConfig(cfg); err != nil {
		t.Fatalf("gda-config.yaml validation failed: %v", err)
	}

	if cfg.ProjectName != "gda" {
		t.Fatalf("expected project_name gda, got %q", cfg.ProjectName)
	}
	if cfg.SESQueuesTopics == nil {
		t.Fatal("expected ses_queues_topics to be parsed")
	}
	if cfg.EKSAccessEntries == nil {
		t.Fatal("expected eks_access_entries to be parsed")
	}
	if len(cfg.EKSClusterAdmins) < 2 {
		t.Fatalf("expected at least 2 eks_cluster_admins, got %d", len(cfg.EKSClusterAdmins))
	}
}

func TestValidationRejectsMissingFields(t *testing.T) {
	t.Parallel()

	cfg, err := LoadInstallerConfig(writeTestConfig(t, `
project_name: test
region: eu-west-1
`))
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	err = ValidateInstallerConfig(cfg)
	if err == nil {
		t.Fatal("expected validation error for missing required fields")
	}
	if !strings.Contains(err.Error(), "Environment") {
		t.Fatalf("expected error about Environment, got: %v", err)
	}
}

func TestValidationNameLengthWithoutAllowLong(t *testing.T) {
	t.Parallel()

	cfg, err := LoadInstallerConfig(writeTestConfig(t, `
project_name: averylongname123
region: eu-west-1
environment: dev
aws_account_id: "123456789012"
terraform_ver: "1.11.4"
env_template_repo: git@example.com:t/e.git
env_template_repo_branch: main
env_git_repo: git@example.com:c/e.git
gitops_template_repo: git@example.com:t/g.git
gitops_destination_repo: git@example.com:c/g.git
`))
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	err = ValidateInstallerConfig(cfg)
	if err == nil {
		t.Fatal("expected validation error for long project_name")
	}
	if !strings.Contains(err.Error(), "exceeds max length") {
		t.Fatalf("expected length error, got: %v", err)
	}
}

func TestValidationGitSuffixNormalization(t *testing.T) {
	t.Parallel()

	cfg, err := LoadInstallerConfig(writeTestConfig(t, `
project_name: test
region: eu-west-1
environment: dev
aws_account_id: "123456789012"
terraform_ver: "1.11.4"
env_template_repo: git@example.com:t/e.git
env_template_repo_branch: main
env_git_repo: git@example.com:c/env
gitops_template_repo: git@example.com:t/g.git
gitops_destination_repo: https://example.com/c/gitops
`))
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	if err := ValidateInstallerConfig(cfg); err != nil {
		t.Fatalf("validation failed: %v", err)
	}

	if !strings.HasSuffix(cfg.EnvGitRepo, ".git") {
		t.Fatalf("expected env_git_repo to be normalized with .git suffix, got %q", cfg.EnvGitRepo)
	}
	if !strings.HasSuffix(cfg.GitopsDestinationRepo, ".git") {
		t.Fatalf("expected gitops_destination_repo to be normalized with .git suffix, got %q", cfg.GitopsDestinationRepo)
	}
}

func writeTestConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}
	return path
}
