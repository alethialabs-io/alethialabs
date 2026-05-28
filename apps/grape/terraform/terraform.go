package terraform

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
	"github.com/hashicorp/go-version"
	"github.com/hashicorp/hc-install/product"
	"github.com/hashicorp/hc-install/releases"
	"github.com/hashicorp/terraform-exec/tfexec"
	tfjson "github.com/hashicorp/terraform-json"
)

type TerraformCLI struct {
	tf      *tfexec.Terraform
	version string
}

func NewTerraformCLI(ctx context.Context, tfVersion, workDir string, stdout, stderr io.Writer) (*TerraformCLI, error) {
	execPath, err := ensureBinary(ctx, tfVersion)
	if err != nil {
		return nil, fmt.Errorf("failed to ensure terraform binary: %w", err)
	}

	tf, err := tfexec.NewTerraform(workDir, execPath)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize terraform: %w", err)
	}

	if stdout != nil {
		tf.SetStdout(stdout)
	} else {
		tf.SetStdout(os.Stdout)
	}
	if stderr != nil {
		tf.SetStderr(stderr)
	} else {
		tf.SetStderr(os.Stderr)
	}

	return &TerraformCLI{tf: tf, version: tfVersion}, nil
}

func (t *TerraformCLI) Init(ctx context.Context, backendConfig map[string]string, upgrade bool) error {
	fmt.Println("Initializing Terraform...")
	opts := []tfexec.InitOption{tfexec.Reconfigure(true)}
	for k, v := range backendConfig {
		opts = append(opts, tfexec.BackendConfig(k+"="+v))
	}
	if upgrade {
		opts = append(opts, tfexec.Upgrade(true))
	}
	return t.tf.Init(ctx, opts...)
}

func (t *TerraformCLI) Plan(ctx context.Context, varFile, planOutFile string) (bool, error) {
	fmt.Println("Running Terraform plan...")
	opts := []tfexec.PlanOption{
		tfexec.Out(planOutFile),
	}
	if varFile != "" {
		opts = append(opts, tfexec.VarFile(varFile))
	}
	return t.tf.Plan(ctx, opts...)
}

func (t *TerraformCLI) Apply(ctx context.Context, planFile string) error {
	fmt.Println("Applying Terraform plan...")
	return t.tf.Apply(ctx, tfexec.DirOrPlan(planFile))
}

func (t *TerraformCLI) Destroy(ctx context.Context, varFile string) error {
	fmt.Println("Running Terraform destroy...")
	var opts []tfexec.DestroyOption
	if varFile != "" {
		opts = append(opts, tfexec.VarFile(varFile))
	}
	return t.tf.Destroy(ctx, opts...)
}

func (t *TerraformCLI) Output(ctx context.Context) (map[string]interface{}, error) {
	fmt.Println("Getting Terraform outputs...")
	outputMap, err := t.tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get terraform output: %w", err)
	}

	outputs := make(map[string]interface{})
	for k, v := range outputMap {
		var val interface{}
		if err := json.Unmarshal(v.Value, &val); err != nil {
			outputs[k] = string(v.Value)
		} else {
			outputs[k] = val
		}
	}
	return outputs, nil
}

func (t *TerraformCLI) ShowPlanJSON(ctx context.Context, planFile string) (*tfjson.Plan, error) {
	fmt.Println("Generating plan JSON...")
	return t.tf.ShowPlanFile(ctx, planFile)
}

func GenerateBackendConfig(config *types.Configuration) map[string]string {
	return map[string]string{
		"bucket": fmt.Sprintf("%s-%s-%s-idp-state", config.ProjectName, config.EnvironmentStage, config.AwsRegion),
		"key":    fmt.Sprintf("%s-%s-%s-terraform.tfstate", config.ProjectName, config.EnvironmentStage, config.AwsRegion),
		"region": config.AwsRegion,
	}
}

func OverrideTfvars(dir string, config *types.Configuration) (string, error) {
	tfvarsPath := filepath.Join(dir, "terraform.tfvars.json")

	tfvars, err := configurationToTfvars(config)
	if err != nil {
		return "", err
	}

	tfvarsData, err := json.MarshalIndent(tfvars, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to encode tfvars: %w", err)
	}

	if err := os.WriteFile(tfvarsPath, append(tfvarsData, '\n'), 0644); err != nil {
		return "", fmt.Errorf("failed to write tfvars file: %w", err)
	}

	return tfvarsPath, nil
}

func configurationToTfvars(config *types.Configuration) (map[string]interface{}, error) {
	if config == nil {
		return nil, fmt.Errorf("configuration cannot be nil")
	}

	if config.FullConfig != nil && strings.TrimSpace(*config.FullConfig) != "" {
		var tfvars map[string]interface{}
		if err := json.Unmarshal([]byte(*config.FullConfig), &tfvars); err != nil {
			return nil, fmt.Errorf("failed to parse raw configuration for tfvars: %w", err)
		}
		return tfvars, nil
	}

	tfvars := map[string]interface{}{
		"project_name":   config.ProjectName,
		"region":         config.AwsRegion,
		"environment":    config.EnvironmentStage,
		"aws_account_id": config.AwsAccountID,
		"terraform_ver":  config.TerraformVersion,
	}

	setIfBoolPtr(tfvars, "provision_vpc", config.CreateVpc)
	setIfStringPtr(tfvars, "vpc_cidr", config.VpcCidr)
	setIfStringPtr(tfvars, "dns_hosted_zone", config.DnsHostedZone)
	setIfStringPtr(tfvars, "dns_main_domain", config.DnsDomainName)
	setIfNotEmpty(tfvars, "env_template_repo", config.EnvTemplateRepo)
	setIfNotEmpty(tfvars, "env_template_repo_branch", config.EnvTemplateRepoBranch)
	setIfNotEmpty(tfvars, "env_git_repo", config.EnvGitRepo)
	setIfNotEmpty(tfvars, "gitops_template_repo", config.GitopsTemplateRepo)
	setIfNotEmpty(tfvars, "gitops_template_repo_branch", config.GitopsTemplateRepoBranch)
	setIfNotEmpty(tfvars, "gitops_destination_repo", config.GitopsDestinationRepo)
	setIfNotEmpty(tfvars, "applications_template_repo", config.ApplicationsTemplateRepo)
	setIfNotEmpty(tfvars, "applications_template_repo_branch", config.ApplicationsTemplateRepoBranch)
	setIfNotEmpty(tfvars, "applications_destination_repo", config.ApplicationsDestinationRepo)
	setIfStringPtr(tfvars, "gitops_argo_access_token", config.GitopsArgocdToken)
	setIfStringPtr(tfvars, "applications_argo_access_token", config.GitopsAppToken)
	setIfBoolPtr(tfvars, "acm_certificate_enable", config.EnableDns)
	setIfBoolPtr(tfvars, "create_elasticache_redis", config.EnableRedis)
	setIfBoolPtr(tfvars, "enable_karpenter", config.EnableKarpenter)
	setIfBoolPtr(tfvars, "cloudfront_waf_enabled", config.EnableCloudfrontWaf)
	if config.DbMinCapacity != nil {
		tfvars["create_rds"] = true
		tfvars["rds_scaling_config"] = map[string]interface{}{"min_capacity": *config.DbMinCapacity}
	}
	if config.RedisAllowedCidrBlocks != nil && *config.RedisAllowedCidrBlocks != "" {
		tfvars["redis_allowed_cidr_blocks"] = strings.Split(*config.RedisAllowedCidrBlocks, ",")
	}

	return tfvars, nil
}

func setIfNotEmpty(values map[string]interface{}, key, value string) {
	if value != "" {
		values[key] = value
	}
}

func setIfStringPtr(values map[string]interface{}, key string, value *string) {
	if value != nil && *value != "" {
		values[key] = *value
	}
}

func setIfBoolPtr(values map[string]interface{}, key string, value *bool) {
	if value != nil {
		values[key] = *value
	}
}

func ensureBinary(ctx context.Context, tfVersion string) (string, error) {
	if path, err := exec.LookPath("terraform"); err == nil {
		return path, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}

	installDir := filepath.Join(home, ".grape", "bin")
	cachedPath := filepath.Join(installDir, fmt.Sprintf("terraform_%s", tfVersion))
	if _, err := os.Stat(cachedPath); err == nil {
		return cachedPath, nil
	}

	if err := os.MkdirAll(installDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create install directory: %w", err)
	}

	v, err := version.NewVersion(tfVersion)
	if err != nil {
		return "", fmt.Errorf("invalid terraform version '%s': %w", tfVersion, err)
	}

	fmt.Printf("Downloading Terraform v%s...\n", tfVersion)
	installer := &releases.ExactVersion{
		Product:    product.Terraform,
		Version:    v,
		InstallDir: installDir,
	}
	execPath, err := installer.Install(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to install terraform v%s: %w", tfVersion, err)
	}

	if err := os.Rename(execPath, cachedPath); err != nil {
		return execPath, nil
	}

	fmt.Println("Terraform downloaded successfully.")
	return cachedPath, nil
}
