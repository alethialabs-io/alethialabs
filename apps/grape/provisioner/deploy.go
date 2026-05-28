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

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/aws"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/git"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/helm"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/infracost"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/k8s"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/state"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/terraform"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/utils"
)

type DeployParams struct {
	Config                *types.Configuration
	InstallerConfig       *types.InstallerConfig
	DryRun                bool
	AwsProfile            string
	UpdateInfra           bool
	UpdateGitOps          bool
	UpdateAll             bool
	UpdateInfraFactsOnly  bool
	CreateStateBucketOnly bool
	InfracostToken        string
	Stdout                io.Writer
	Stderr                io.Writer
	ApiClient             *api.Client
	DeploymentID          string
	// RepoCreatePrompt is called when a repo doesn't exist and needs creation.
	// If nil, repo creation is skipped (headless/worker mode).
	RepoCreatePrompt func(repoURL string) bool
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

		s3Client, err := aws.NewS3Client(ctx, aws.AWSOptions{Region: config.AwsRegion, Profile: params.AwsProfile})
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

	// Git repo cloning
	logger.Info("Cloning template repositories...", "git")
	argoTemplateRepo := git.NewGIT(config.GitopsTemplateRepo, "git/template_argo_repo", params.DryRun)
	if err := handleRepoClone(argoTemplateRepo, config.GitopsTemplateRepoBranch, true, params, logger); err != nil {
		return err
	}

	envTemplateRepo := git.NewGIT(config.EnvTemplateRepo, "git/template_repo", params.DryRun)
	if err := handleRepoClone(envTemplateRepo, config.EnvTemplateRepoBranch, true, params, logger); err != nil {
		return err
	}

	var applicationsTemplateRepo *git.GIT
	if config.ApplicationsTemplateRepo != "" {
		applicationsTemplateRepo = git.NewGIT(config.ApplicationsTemplateRepo, "git/template_applications_repo", params.DryRun)
		if err := handleRepoClone(applicationsTemplateRepo, config.ApplicationsTemplateRepoBranch, true, params, logger); err != nil {
			return err
		}
	}

	logger.Info("Cloning client repositories...", "git")
	argoClientRepo := git.NewGIT(config.GitopsDestinationRepo, "git/client_argo_repo", params.DryRun)
	if err := handleRepoClone(argoClientRepo, "", false, params, logger); err != nil {
		return err
	}

	envClientRepo := git.NewGIT(config.EnvGitRepo, "git/client_repo", params.DryRun)
	if err := handleRepoClone(envClientRepo, "", false, params, logger); err != nil {
		return err
	}

	var applicationsClientRepo *git.GIT
	if config.ApplicationsDestinationRepo != "" {
		applicationsClientRepo = git.NewGIT(config.ApplicationsDestinationRepo, "git/client_applications_repo", params.DryRun)
		if err := handleRepoClone(applicationsClientRepo, "", false, params, logger); err != nil {
			return err
		}
	}

	tfDir, err := filepath.Abs(envClientRepo.LocalPath)
	if err != nil {
		logger.Error(fmt.Sprintf("Error getting absolute path: %v", err), "terraform")
		return err
	}

	repoFilesMap := map[string]string{
		"variable-template/terraform.tfvars": "terraform.tfvars",
		"backends/backend.tfvars":            "backend.tfvars",
	}

	err = envClientRepo.Bootstrap(envTemplateRepo, repoFilesMap, params.UpdateInfra || params.UpdateAll, logger)
	if err != nil {
		logger.Error(fmt.Sprintf("Error bootstrapping infrastructure repo: %v", err), "git")
		updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
		return err
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
	if err := infracostCLI.RunInfracost(infracostInput, infracostEnv); err != nil {
		logger.Warn(fmt.Sprintf("Infracost analysis failed: %v", err), "infracost")
	}

	if !params.DryRun {
		logger.Info("Applying Terraform changes...", "terraform-apply")
		err = tf.Apply(ctx, planFile)
		if err != nil {
			logger.Error(fmt.Sprintf("Error running terraform apply: %v", err), "terraform-apply")
			updateStatus(params.ApiClient, params.DeploymentID, "failed", err.Error())
			return err
		}
	} else {
		logger.Info("Dry-run mode: Skipping terraform apply.", "terraform-apply")
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
		k8sCLI, err := k8s.NewK8sCLI(aws.AWSOptions{Region: config.AwsRegion, Profile: params.AwsProfile}, params.DryRun)
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
