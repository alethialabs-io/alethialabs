package provisioner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/argocd"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/cloud"
	grapeAws "github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/cloud/aws"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/infracost"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/terraform"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/utils"
)

type DeployParams struct {
	VineConfig      *types.VineConfig
	Provider        string
	PlanFile        string
	DryRun          bool
	UpdateInfra     bool
	InfracostToken  string
	GitAccessToken  string
	TemplatesDir    string
	SupabaseBackend *cloud.SupabaseBackendConfig
	Stdout          io.Writer
	Stderr          io.Writer
	ApiClient       *api.Client
	DeploymentID    string
}

// PlanResult holds structured output from a deployment (dry-run or full apply).
type PlanResult struct {
	PlanJSON            map[string]interface{}
	CostBreakdown       *infracost.CostBreakdown
	PlanFileBytes       []byte
	Outputs             map[string]interface{}
	ClusterName         string
	ClusterEndpoint     string
	ArgocdURL           string
	ArgocdAdminPassword string
}

// RunDeployV2 executes a deployment using the provider-agnostic VineConfig and CloudProvider interface.
func RunDeployV2(ctx context.Context, params DeployParams) (*PlanResult, error) {
	vc := params.VineConfig
	if vc == nil {
		return nil, fmt.Errorf("VineConfig is required for RunDeployV2")
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	fmt.Fprintf(stdout, "Starting deployment for project: %s (provider: %s)\n", vc.ProjectName, provider.Name())

	if !params.DryRun {
		if err := utils.CheckDependencies(provider.RequiredCLIs()...); err != nil {
			return nil, fmt.Errorf("preflight check failed: %w", err)
		}
	}

	if params.DryRun {
		fmt.Fprintln(stdout, "Running in dry-run (plan) mode")
	}

	tmpRoot, err := os.MkdirTemp("", "grape-deploy-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	var tfDir string
	if params.TemplatesDir != "" {
		fmt.Fprintf(stdout, "Using bundled templates from %s\n", params.TemplatesDir)
		workDir := filepath.Join(tmpRoot, "work")
		if err := copyDir(params.TemplatesDir, workDir); err != nil {
			return nil, fmt.Errorf("failed to copy templates: %w", err)
		}
		tfDir = workDir
	} else {
		return nil, fmt.Errorf("git-based deployment not yet supported in V2; use TemplatesDir")
	}

	tf, err := terraform.NewTerraformCLI(ctx, vc.TerraformVersion, tfDir, stdout, stderr)
	if err != nil {
		return nil, fmt.Errorf("terraform init failed: %w", err)
	}

	tfvars := provider.ProviderTfvars(vc)

	if !vc.Network.ProvisionNetwork && vc.Network.NetworkID != "" && provider.Name() == "aws" {
		tfvars["vpc_id"] = vc.Network.NetworkID
		fmt.Fprintf(stdout, "Using existing VPC %s — looking up subnets...\n", vc.Network.NetworkID)
		ec2Client, ec2Err := grapeAws.NewEC2Client(ctx, grapeAws.AWSOptions{Region: vc.Region})
		if ec2Err != nil {
			fmt.Fprintf(stderr, "Warning: failed to create EC2 client for subnet lookup: %v\n", ec2Err)
		} else {
			subnets, subErr := ec2Client.ListSubnets(ctx, vc.Network.NetworkID)
			if subErr != nil {
				fmt.Fprintf(stderr, "Warning: failed to list subnets: %v\n", subErr)
			} else {
				privateIDs := make([]string, 0)
				publicIDs := make([]string, 0)
				for _, s := range subnets {
					if s.MapPublicIpOnLaunch {
						publicIDs = append(publicIDs, s.ID)
					} else {
						privateIDs = append(privateIDs, s.ID)
					}
				}
				if len(publicIDs) == 0 {
					publicIDs = privateIDs
				}
				if len(privateIDs) == 0 {
					privateIDs = publicIDs
				}
				tfvars["vpc_private_subnet_ids"] = privateIDs
				tfvars["vpc_public_subnet_ids"] = publicIDs
				fmt.Fprintf(stdout, "Found %d private and %d public subnets\n", len(privateIDs), len(publicIDs))
			}
		}
	}

	if params.SupabaseBackend == nil {
		return nil, fmt.Errorf("SupabaseBackend config is required for state storage")
	}
	backendFile, err := params.SupabaseBackend.WriteBackendHCL(tfDir, vc.VineyardID, vc.ProjectName, vc.EnvironmentStage, vc.Region)
	if err != nil {
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}
	fmt.Fprintf(stdout, "State backend: Supabase S3 (bucket=%s)\n", params.SupabaseBackend.Bucket)

	fmt.Fprintf(stdout, "DEBUG provider=%s, project=%v, region=%v, provision_network=%v, network_id=%q, cidr=%q\n",
		provider.Name(), tfvars["project_name"], vc.Region, vc.Network.ProvisionNetwork, vc.Network.NetworkID, vc.Network.CIDRBlock)

	varFile, err := terraform.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	planFile, err := filepath.Abs(filepath.Join(tfDir, "terraform.plan.out"))
	if err != nil {
		return nil, err
	}

	// Suspend AWS env creds during init so the S3 backend uses inline Supabase creds from backend.hcl
	// (ECS task role always sets AWS env vars, which would override the Supabase S3 endpoint)
	savedCreds := suspendAWSEnvCreds()
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		restoreAWSEnvCreds(savedCreds)
		return nil, fmt.Errorf("terraform init failed: %w", err)
	}
	restoreAWSEnvCreds(savedCreds)

	if params.PlanFile != "" {
		fmt.Fprintf(stdout, "Using pre-approved plan file (skipping re-plan)\n")
		planFile = params.PlanFile
	} else {
		if _, err := tf.Plan(ctx, varFile, planFile); err != nil {
			return nil, fmt.Errorf("terraform plan failed: %w", err)
		}
	}

	var result PlanResult

	planJSON, showErr := tf.ShowPlanJSON(ctx, planFile)
	planJSONFile := ""
	if showErr != nil {
		fmt.Fprintf(stdout, "Warning: terraform show -json failed: %v\n", showErr)
	}
	if planJSON != nil {
		planJSONFile = filepath.Join(tmpRoot, "terraform.plan.json")
		if jsonBytes, marshalErr := json.Marshal(planJSON); marshalErr == nil {
			os.WriteFile(planJSONFile, jsonBytes, 0644)
			var parsed map[string]interface{}
			if json.Unmarshal(jsonBytes, &parsed) == nil {
				result.PlanJSON = parsed
			}
		}
	}

	if params.InfracostToken != "" {
		infracostEnv := []string{"INFRACOST_API_KEY=" + params.InfracostToken}
		infracostCLI := infracost.NewInfracostCLI("v0.10.39", params.InfracostToken)
		infracostInput := planFile
		if planJSONFile != "" {
			infracostInput = planJSONFile
		}
		costBreakdown, err := infracostCLI.RunInfracost(infracostInput, infracostEnv)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: Infracost analysis failed: %v\n", err)
		} else if costBreakdown != nil {
			result.CostBreakdown = costBreakdown
		}
	}

	if params.DryRun {
		if planBytes, readErr := os.ReadFile(planFile); readErr == nil {
			result.PlanFileBytes = planBytes
		}
		fmt.Fprintln(stdout, "Dry-run complete. Plan and cost analysis finished.")
		return &result, nil
	}

	fmt.Fprintln(stdout, "Applying Terraform changes...")
	if err := tf.Apply(ctx, planFile); err != nil {
		return nil, fmt.Errorf("terraform apply failed: %w", err)
	}

	outputs, err := tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get terraform outputs: %w", err)
	}

	result.Outputs = outputs
	result.ClusterName = cloud.ExtractClusterName(outputs)
	result.ClusterEndpoint = cloud.ExtractClusterEndpoint(outputs)

	if result.ClusterName != "" {
		if err := provider.ConfigureKubeconfig(ctx, vc, outputs, stdout); err != nil {
			fmt.Fprintf(stdout, "Warning: kubeconfig configuration failed: %v\n", err)
		}
	}

	if !params.DryRun && result.ClusterName != "" {
		if err := installArgoCD(ctx, vc, &result, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: ArgoCD installation failed: %v\n", err)
		}

		argoTemplatesDir := resolveArgoTemplatesDir()
		if argoTemplatesDir != "" {
			facts := argocd.BuildFromOutputs(result.Outputs, vc)
			renderedDir, renderErr := argocd.RenderApplications(argoTemplatesDir, facts)
			if renderErr != nil {
				fmt.Fprintf(stderr, "Warning: failed to render ArgoCD applications: %v\n", renderErr)
			} else {
				defer os.RemoveAll(renderedDir)
				if applyErr := argocd.ApplyApplications(renderedDir, stdout, stderr); applyErr != nil {
					fmt.Fprintf(stderr, "Warning: failed to apply ArgoCD applications: %v\n", applyErr)
				}
			}
		} else {
			fmt.Fprintln(stdout, "No ArgoCD application templates found, skipping infra-services.")
		}
	}

	fmt.Fprintln(stdout, "Deployment completed successfully.")
	return &result, nil
}

func resolveArgoTemplatesDir() string {
	candidates := []string{
		"/home/tendril/argocd-templates",
		"argocd-templates",
		"../../infra/templates/argocd",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

func installArgoCD(ctx context.Context, vc *types.VineConfig, result *PlanResult, stdout, stderr io.Writer) error {
	fmt.Fprintln(stdout, "Installing ArgoCD...")

	addRepoCmd := "helm repo add argo https://argoproj.github.io/argo-helm && helm repo update"
	if err := utils.ExecuteCommand(addRepoCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to add ArgoCD helm repo: %w", err)
	}

	installCmd := "helm upgrade --install argo-cd argo/argo-cd --namespace argocd --create-namespace --version 7.1.3 --wait --timeout 5m"
	if err := utils.ExecuteCommand(installCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to install ArgoCD: %w", err)
	}

	fmt.Fprintln(stdout, "ArgoCD installed. Extracting admin credentials...")

	passwordCmd := "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>/dev/null | base64 -d"
	password, err := utils.ExecuteCommandWithOutput(passwordCmd, ".", nil)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not extract ArgoCD admin password: %v\n", err)
	} else {
		result.ArgocdAdminPassword = strings.TrimSpace(password)
	}

	if vc.DNS.DomainName != "" {
		result.ArgocdURL = fmt.Sprintf("https://argocd.%s", vc.DNS.DomainName)
	}

	fmt.Fprintf(stdout, "ArgoCD ready. URL: %s\n", result.ArgocdURL)
	return nil
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode())
	})
}

func suspendAWSEnvCreds() map[string]string {
	keys := []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"}
	saved := make(map[string]string, len(keys))
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			saved[k] = v
			os.Unsetenv(k)
		}
	}
	return saved
}

func restoreAWSEnvCreds(saved map[string]string) {
	for k, v := range saved {
		os.Setenv(k, v)
	}
}
