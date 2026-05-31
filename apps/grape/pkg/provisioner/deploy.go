package provisioner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/cloud"
	grapeAws "github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/cloud/aws"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/git"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/helm"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/infracost"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/k8s"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/state"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/terraform"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/utils"
)

type DeployParams struct {
	Config                *types.Configuration
	VineConfig            *types.VineConfig
	Provider              string
	InstallerConfig       *types.InstallerConfig
	DryRun                bool
	AwsProfile            string
	UpdateInfra           bool
	UpdateGitOps          bool
	UpdateAll             bool
	UpdateInfraFactsOnly  bool
	CreateStateBucketOnly bool
	InfracostToken        string
	GitAccessToken        string
	TemplatesDir          string
	Stdout                io.Writer
	Stderr                io.Writer
	ApiClient             *api.Client
	DeploymentID          string
	// RepoCreatePrompt is called when a repo doesn't exist and needs creation.
	// If nil, repo creation is skipped (headless/worker mode).
	RepoCreatePrompt func(repoURL string) bool
}

// PlanResult holds structured output from a deployment (dry-run or full apply).
type PlanResult struct {
	PlanJSON        map[string]interface{}
	CostBreakdown   *infracost.CostBreakdown
	Outputs         map[string]interface{}
	ClusterName     string
	ClusterEndpoint string
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

	if err := utils.CheckDependencies(provider.RequiredCLIs()...); err != nil {
		return nil, fmt.Errorf("preflight check failed: %w", err)
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

	backendConfig := provider.BackendConfig(vc.ProjectName, vc.EnvironmentStage, vc.Region)
	tfvars := provider.ProviderTfvars(vc)

	if provider.Name() == "aws" {
		fmt.Fprintf(stdout, "Ensuring state bucket %s exists...\n", backendConfig["bucket"])
		s3Client, err := grapeAws.NewS3Client(ctx, grapeAws.AWSOptions{Region: vc.Region})
		if err != nil {
			return nil, fmt.Errorf("failed to create S3 client: %w", err)
		}
		if err := s3Client.CreateS3BucketIfNotExists(ctx, backendConfig["bucket"], vc.Region, false); err != nil {
			return nil, fmt.Errorf("failed to create state bucket: %w", err)
		}
	}

	fmt.Fprintf(stdout, "DEBUG tfvars: provision_vpc=%v, vpc_cidr=%v, aws_account_id=%v\n", tfvars["provision_vpc"], tfvars["vpc_cidr"], tfvars["aws_account_id"])

	varFile, err := terraform.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	planFile, err := filepath.Abs(filepath.Join(tfDir, "terraform.plan.out"))
	if err != nil {
		return nil, err
	}

	if err := tf.Init(ctx, backendConfig, false); err != nil {
		return nil, fmt.Errorf("terraform init failed: %w", err)
	}

	if _, err := tf.Plan(ctx, varFile, planFile); err != nil {
		return nil, fmt.Errorf("terraform plan failed: %w", err)
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

	if ep, ok := outputs["eks_cluster_endpoint"]; ok {
		if m, ok := ep.(map[string]interface{}); ok {
			if v, ok := m["value"].(string); ok {
				result.ClusterEndpoint = v
			}
		} else if s, ok := ep.(string); ok {
			result.ClusterEndpoint = s
		}
	}

	if result.ClusterName != "" {
		if err := provider.ConfigureKubeconfig(ctx, result.ClusterName, vc.Region, stdout); err != nil {
			fmt.Fprintf(stdout, "Warning: kubeconfig configuration failed: %v\n", err)
		}
	}

	fmt.Fprintln(stdout, "Deployment completed successfully.")
	return &result, nil
}

func RunDeploy(ctx context.Context, params DeployParams) error {
	config := params.Config
	logger := utils.NewLogger(params.ApiClient, params.DeploymentID)

	logger.Info(fmt.Sprintf("Starting deployment for project: %s", config.ProjectName), "")

	if !params.CreateStateBucketOnly {
		if err := utils.CheckDependencies("aws", "kubectl", "helm"); err != nil {
			logger.Error(err.Error(), "preflight")
			updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
			return err
		}
	}

	if params.DryRun {
		logger.Info("Running in dry-run mode", "setup")
	}

	if params.CreateStateBucketOnly {
		logger.Info("Only creating state bucket", "s3")
		bucketName := fmt.Sprintf("%s-%s-%s-idp-state", config.ProjectName, config.EnvironmentStage, config.AwsRegion)

		s3Client, err := grapeAws.NewS3Client(ctx, grapeAws.AWSOptions{Region: config.AwsRegion, Profile: params.AwsProfile})
		if err != nil {
			logger.Error(fmt.Sprintf("Error creating S3 client: %v", err), "s3")
			return err
		}

		err = s3Client.CreateS3BucketIfNotExists(ctx, bucketName, config.AwsRegion, params.DryRun)
		if err != nil {
			logger.Error(fmt.Sprintf("Error creating S3 bucket: %v", err), "s3")
			return err
		}
		updateStatus(params.ApiClient, params.DeploymentID, "completed", "")
		return nil
	}

	var tfDir string
	var argoTemplateRepo *git.GIT
	var argoClientRepo *git.GIT
	var applicationsTemplateRepo *git.GIT
	var applicationsClientRepo *git.GIT
	var envTemplateRepo *git.GIT

	if params.TemplatesDir != "" {
		// Use bundled templates — no git cloning needed
		logger.Info("Using bundled templates from "+params.TemplatesDir, "setup")
		workDir := filepath.Join("work", config.ProjectName)
		os.RemoveAll(workDir)
		if err := copyDir(params.TemplatesDir, workDir); err != nil {
			logger.Error(fmt.Sprintf("Failed to copy templates: %v", err), "setup")
			return err
		}
		absDir, absErr := filepath.Abs(workDir)
		if absErr != nil {
			logger.Error(fmt.Sprintf("Error getting absolute path: %v", absErr), "terraform")
			return absErr
		}
		tfDir = absDir
	} else {
		// Legacy: clone git repos
		newGit := func(repoURL, localPath string) *git.GIT {
			if params.GitAccessToken != "" {
				return git.NewGITWithToken(repoURL, localPath, params.DryRun, params.GitAccessToken)
			}
			return git.NewGIT(repoURL, localPath, params.DryRun)
		}

		logger.Info("Cloning template repositories...", "git")
		argoTemplateRepo = newGit(config.GitopsTemplateRepo, "git/template_argo_repo")
		if err := handleRepoClone(argoTemplateRepo, config.GitopsTemplateRepoBranch, true, params, logger); err != nil {
			return err
		}

		envTemplateRepo = newGit(config.EnvTemplateRepo, "git/template_repo")
		if err := handleRepoClone(envTemplateRepo, config.EnvTemplateRepoBranch, true, params, logger); err != nil {
			return err
		}

		if config.ApplicationsTemplateRepo != "" {
			applicationsTemplateRepo = newGit(config.ApplicationsTemplateRepo, "git/template_applications_repo")
			if err := handleRepoClone(applicationsTemplateRepo, config.ApplicationsTemplateRepoBranch, true, params, logger); err != nil {
				return err
			}
		}

		logger.Info("Cloning client repositories...", "git")
		argoClientRepo = newGit(config.GitopsDestinationRepo, "git/client_argo_repo")
		if err := handleRepoClone(argoClientRepo, "", false, params, logger); err != nil {
			return err
		}

		envClientRepo := newGit(config.EnvGitRepo, "git/client_repo")
		if err := handleRepoClone(envClientRepo, "", false, params, logger); err != nil {
			return err
		}

		if config.ApplicationsDestinationRepo != "" {
			applicationsClientRepo = newGit(config.ApplicationsDestinationRepo, "git/client_applications_repo")
			if err := handleRepoClone(applicationsClientRepo, "", false, params, logger); err != nil {
				return err
			}
		}

		absDir, absErr := filepath.Abs(envClientRepo.LocalPath)
		if absErr != nil {
			logger.Error(fmt.Sprintf("Error getting absolute path: %v", absErr), "terraform")
			return absErr
		}
		tfDir = absDir

		repoFilesMap := map[string]string{
			"variable-template/terraform.tfvars": "terraform.tfvars",
			"backends/backend.tfvars":            "backend.tfvars",
		}

		if bsErr := envClientRepo.Bootstrap(envTemplateRepo, repoFilesMap, params.UpdateInfra || params.UpdateAll, logger); bsErr != nil {
			logger.Error(fmt.Sprintf("Error bootstrapping infrastructure repo: %v", bsErr), "git")
			updateStatus(params.ApiClient, params.DeploymentID, "failed", bsErr.Error())
			return bsErr
		}
	}

	tf, err := terraform.NewTerraformCLI(ctx, config.TerraformVersion, tfDir, nil, nil)
	if err != nil {
		logger.Error(fmt.Sprintf("Error initializing Terraform: %v", err), "terraform")
		return err
	}

	backendConfig := terraform.GenerateBackendConfig(config)

	varFile, err := terraform.OverrideTfvars(tfDir, config)
	if err != nil {
		logger.Error(fmt.Sprintf("Error overriding tfvars: %v", err), "terraform")
		return err
	}

	planFile, err := filepath.Abs(filepath.Join(tfDir, "terraform.plan.out"))
	if err != nil {
		logger.Error(fmt.Sprintf("Error getting absolute path for plan file: %v", err), "terraform")
		return err
	}
	defer os.Remove(planFile)

	err = tf.Init(ctx, backendConfig, params.UpdateInfra)
	if err != nil {
		logger.Error(fmt.Sprintf("Error running terraform init: %v", err), "terraform-init")
		updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
		return err
	}

	_, err = tf.Plan(ctx, varFile, planFile)
	if err != nil {
		logger.Error(fmt.Sprintf("Error running terraform plan: %v", err), "terraform-plan")
		updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
		return err
	}

	planJSON, planJSONErr := tf.ShowPlanJSON(ctx, planFile)
	planJSONFile := ""
	if planJSONErr == nil && planJSON != nil {
		planJSONFile = filepath.Join("temp", "terraform.plan.json")
		os.MkdirAll("temp", 0755)
		if jsonBytes, err := json.Marshal(planJSON); err == nil {
			os.WriteFile(planJSONFile, jsonBytes, 0644)
		}
	}

	var infracostEnv []string
	if params.InfracostToken != "" {
		infracostEnv = append(infracostEnv, "INFRACOST_API_KEY="+params.InfracostToken)
	}
	infracostCLI := infracost.NewInfracostCLI("v0.10.39", params.InfracostToken)
	infracostInput := planFile
	if planJSONFile != "" {
		infracostInput = planJSONFile
	}
	if _, err := infracostCLI.RunInfracost(infracostInput, infracostEnv); err != nil {
		logger.Warn(fmt.Sprintf("Infracost analysis failed: %v", err), "infracost")
	}

	if !params.DryRun {
		logger.Info("Applying Terraform changes...", "terraform-apply")
		if applyErr := tf.Apply(ctx, planFile); applyErr != nil {
			logger.Error(fmt.Sprintf("Error running terraform apply: %v", applyErr), "terraform-apply")
			updateStatus(params.ApiClient, params.DeploymentID, "failed", applyErr.Error())
			return applyErr
		}
	} else {
		logger.Info("Dry-run complete. Plan and cost analysis finished.", "plan")
		return nil
	}

	if params.TemplatesDir != "" {
		logger.Info("Templates mode: skipping post-apply git/helm operations.", "setup")
		return nil
	}

	outputs, err := tf.Output(ctx)
	if err != nil {
		logger.Error(fmt.Sprintf("Error retrieving terraform outputs: %v", err), "terraform-output")
		updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
		return err
	}

	logger.Info(fmt.Sprintf("Terraform Outputs: %+v", outputs), "terraform-output")

	s := state.NewState()
	var rawConfig map[string]interface{}
	if params.InstallerConfig != nil {
		rawConfig = params.InstallerConfig.Raw
	} else if config.FullConfig != nil {
		rawConfig, _ = state.RawConfigFromFullConfig(config.FullConfig)
	}
	if rawConfig == nil {
		rawConfig = make(map[string]interface{})
	}
	err = s.SaveInfraFacts(rawConfig, outputs, params.DryRun, logger)
	if err != nil {
		logger.Error(fmt.Sprintf("Error saving infra-facts: %v", err), "state")
		updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
		return err
	}

	err = argoClientRepo.BootstrapArgo(config, argoTemplateRepo, "temp/infra-facts.yaml", params.UpdateGitOps || params.UpdateAll, params.UpdateInfraFactsOnly, logger)
	if err != nil {
		logger.Error(fmt.Sprintf("Error bootstrapping Argo repo: %v", err), "git")
		updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
		return err
	}

	if applicationsClientRepo != nil && applicationsTemplateRepo != nil {
		err = applicationsClientRepo.BootstrapAppRepo(config, applicationsTemplateRepo, "temp/infra-facts.yaml", params.UpdateGitOps || params.UpdateAll, params.UpdateInfraFactsOnly, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error bootstrapping applications repo: %v", err), "git")
			updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
			return err
		}
	}

	if params.UpdateInfraFactsOnly {
		logger.Info("Exiting due to --update-infra-facts-only", "done")
		updateStatus(params.ApiClient, params.DeploymentID, "completed", "")
		return nil
	}

	// K8s context and Helm/K8s operations
	var clusterName string
	if val, ok := outputs["eks_cluster_name"]; ok {
		if m, ok := val.(map[string]interface{}); ok {
			if v, ok := m["value"].(string); ok {
				clusterName = v
			}
		}
	}

	if clusterName == "" {
		if params.DryRun {
			logger.Warn("No EKS cluster name found in outputs. Skipping K8s steps (expected in dry-run).", "k8s")
		} else {
			logger.Error("EKS cluster name not found in outputs. Cannot proceed with K8s steps.", "k8s")
			updateStatus(params.ApiClient, params.DeploymentID, "failed", "EKS cluster name not found in outputs")
			return fmt.Errorf("EKS cluster name not found in outputs")
		}
	} else {
		k8sCLI, err := k8s.NewK8sCLI(grapeAws.AWSOptions{Region: config.AwsRegion, Profile: params.AwsProfile}, params.DryRun)
		if err != nil {
			logger.Error(fmt.Sprintf("Error initializing K8s CLI: %v", err), "k8s")
			return err
		}

		err = k8sCLI.GetContext(clusterName, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error getting K8s context: %v", err), "k8s")
			return err
		}

		helmCLI := helm.NewHelmCLI(params.DryRun)
		argocdValuesGenerated := filepath.Join(argoClientRepo.LocalPath, "helm/argo-cd/values", config.EnvironmentStage, config.AwsRegion, "values.generated.yaml")
		argocdValuesPath := filepath.Join(argoClientRepo.LocalPath, "helm/argo-cd/values", config.EnvironmentStage, config.AwsRegion, "values.yaml")
		argocdValuesFiles := []string{}
		if _, err := os.Stat(argocdValuesGenerated); err == nil {
			argocdValuesFiles = append(argocdValuesFiles, argocdValuesGenerated)
		}
		argocdValuesFiles = append(argocdValuesFiles, argocdValuesPath)

		var gitopsArgocdToken string
		if config.GitopsArgocdToken != nil {
			gitopsArgocdToken = *config.GitopsArgocdToken
		}

		argocdRepositories := []map[string]string{
			{
				"username": "argocd",
				"password": gitopsArgocdToken,
				"repoUrl":  config.GitopsDestinationRepo,
			},
		}

		if config.ApplicationsTemplateRepo != "" {
			var gitopsAppToken string
			if config.GitopsAppToken != nil {
				gitopsAppToken = *config.GitopsAppToken
			}
			argocdRepositories = append(argocdRepositories, map[string]string{
				"username": "argocd",
				"password": gitopsAppToken,
				"repoUrl":  config.ApplicationsDestinationRepo,
			})
		}

		repoJSON, _ := json.Marshal(argocdRepositories)
		setJSON := fmt.Sprintf("argocdRepositories=%s", string(repoJSON))

		env := map[string]string{
			"AWS_PROFILE": params.AwsProfile,
			"KUBECONFIG":  "temp/kubeconfig",
		}

		err = helmCLI.UpgradeInstall("argocd", filepath.Join(argoClientRepo.LocalPath, "helm/argo-cd"), "argocd", argocdValuesFiles, env, setJSON, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error installing ArgoCD: %v", err), "helm")
			updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
			return err
		}

		logger.Info("Applying ArgoCD manifests...", "k8s")
		err = k8sCLI.Apply("argocd", filepath.Join(argoClientRepo.LocalPath, "manifests/argocd/app-of-app.yaml"), env, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error applying app-of-app manifest: %v", err), "k8s")
		}

		infraSvcManifest := filepath.Join(argoClientRepo.LocalPath, "manifests/applications/infra-app-stages", config.EnvironmentStage, config.AwsRegion, "infra-services.yaml")
		err = k8sCLI.Apply("argocd", infraSvcManifest, env, logger)
		if err != nil {
			logger.Error(fmt.Sprintf("Error applying infra-services manifest: %v", err), "k8s")
		}

		if config.ApplicationsTemplateRepo != "" {
			err = k8sCLI.Apply("argocd", filepath.Join(applicationsClientRepo.LocalPath, "manifests/argocd/app-of-app.yaml"), env, logger)
			if err != nil {
				logger.Error(fmt.Sprintf("Error applying applications app-of-app manifest: %v", err), "k8s")
			}

			appsSvcManifest := filepath.Join(applicationsClientRepo.LocalPath, "manifests/applications/applications-app-stages", config.EnvironmentStage, config.AwsRegion, "applications.yaml")
			err = k8sCLI.Apply("argocd", appsSvcManifest, env, logger)
			if err != nil {
				logger.Error(fmt.Sprintf("Error applying applications manifest: %v", err), "k8s")
			}
		}
	}

	updateStatus(params.ApiClient, params.DeploymentID, "completed", "")
	logger.Info("Deployment completed successfully.", "done")
	return nil
}

func handleRepoClone(g *git.GIT, branch string, force bool, params DeployParams, logger *utils.Logger) error {
	const maxRetries = 3
	repoCreated := false

	for attempt := 1; attempt <= maxRetries; attempt++ {
		err := g.Clone(branch, force)
		if err == nil {
			return nil
		}

		if !errors.Is(err, git.ErrRepoNotFound) && !errors.Is(err, git.ErrRepoEmpty) {
			logger.Error(fmt.Sprintf("Error cloning repo %s: %v", g.RepoURL, err), "git")
			return err
		}

		if repoCreated {
			logger.Error(fmt.Sprintf("Clone still failing after repo creation (attempt %d/%d): %v", attempt, maxRetries, err), "git")
			if attempt < maxRetries {
				time.Sleep(time.Duration(attempt*2) * time.Second)
				continue
			}
			return fmt.Errorf("failed to clone repo %s after creation", g.RepoURL)
		}

		if params.ApiClient == nil {
			logger.Error(fmt.Sprintf("Repository %s not found or is empty. Create it manually, then retry.", g.RepoURL), "git")
			return fmt.Errorf("repository %s not found and no API client to create it", g.RepoURL)
		}

		shouldCreate := false
		if params.RepoCreatePrompt != nil {
			shouldCreate = params.RepoCreatePrompt(g.RepoURL)
		}

		if !shouldCreate {
			return fmt.Errorf("repository %s not found, creation declined", g.RepoURL)
		}

		repoURL, _ := url.Parse(g.RepoURL)
		repoParts := strings.Split(strings.TrimSuffix(repoURL.Path, ".git"), "/")
		repoName := repoParts[len(repoParts)-1]

		var provider string
		if strings.Contains(repoURL.Host, "github.com") {
			provider = "github"
		} else if strings.Contains(repoURL.Host, "gitlab.com") {
			provider = "gitlab"
		} else if strings.Contains(repoURL.Host, "bitbucket.org") {
			provider = "bitbucket"
		} else {
			return fmt.Errorf("unknown Git provider for repository: %s", g.RepoURL)
		}

		_, err = params.ApiClient.CreateRepository(provider, repoName, "", "")
		if err != nil {
			logger.Error(fmt.Sprintf("Error creating repository: %v", err), "git")
			return err
		}
		logger.Info("Repository created successfully. Retrying clone...", "git")
		repoCreated = true
		time.Sleep(2 * time.Second)
	}
	return nil
}

func updateStatus(apiClient *api.Client, deploymentID, status, errorMessage string) {
	if apiClient == nil || deploymentID == "" {
		return
	}
	apiClient.UpdateDeploymentStatus(deploymentID, status, errorMessage)
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
