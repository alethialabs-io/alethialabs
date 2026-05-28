package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/AlecAivazis/survey/v2"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/api"
	grapeconfig "github.com/bobikenobi12/bb-thesis-2026/apps/grape/config"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/provisioner"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
	"github.com/spf13/cobra"
)

var (
	dryRun                bool
	createStateBucketOnly bool
	updateInfra           bool
	updateGitOps          bool
	updateAll             bool
	updateInfraFactsOnly  bool
	infracostToken        string
	awsProfile            string
	deployConfigFile      string
)

var deployCmd = &cobra.Command{
	Use:   "deploy [project_name]",
	Short: "[LEGACY] Deploy a project's infrastructure locally",
	Args: func(cmd *cobra.Command, args []string) error {
		if deployConfigFile == "" {
			return cobra.ExactArgs(1)(cmd, args)
		}
		return cobra.MaximumNArgs(1)(cmd, args)
	},
	Run: func(cmd *cobra.Command, args []string) {
		var apiClient *api.Client
		var config *types.Configuration
		var installerConfig *types.InstallerConfig
		var deploymentID string
		var err error
		projectName := ""

		if len(args) > 0 {
			projectName = args[0]
		}

		if deployConfigFile != "" {
			installerConfig, err = grapeconfig.LoadInstallerConfig(deployConfigFile)
			if err != nil {
				fmt.Printf("Error loading config file: %v\n", err)
				os.Exit(1)
			}

			config, err = grapeconfig.InstallerConfigToConfiguration(installerConfig)
			if err != nil {
				fmt.Printf("Error converting config file: %v\n", err)
				os.Exit(1)
			}
			if projectName != "" && projectName != config.ProjectName {
				fmt.Printf("Error: project argument %q does not match config file project_name %q\n", projectName, config.ProjectName)
				os.Exit(1)
			}
			projectName = config.ProjectName
		} else {
			token, err := getAuthToken()
			if err != nil {
				fmt.Printf("Error getting auth token: %v\n", err)
				os.Exit(1)
			}
			apiClient = api.NewClient(token)

			config, err = apiClient.GetConfiguration(projectName)
			if err != nil {
				fmt.Printf("Error fetching configuration for project '%s': %v\n", projectName, err)
				os.Exit(1)
			}

			deployment, err := apiClient.CreateDeployment(config.ID, fmt.Sprintf("Deployment for %s", projectName), "terraform", config.TerraformVersion)
			if err != nil {
				fmt.Printf("Error creating deployment record: %v\n", err)
				os.Exit(1)
			}
			deploymentID = deployment.ID
		}

		err = provisioner.RunDeploy(context.Background(), provisioner.DeployParams{
			Config:                config,
			InstallerConfig:       installerConfig,
			DryRun:                dryRun,
			AwsProfile:            awsProfile,
			UpdateInfra:           updateInfra,
			UpdateGitOps:          updateGitOps,
			UpdateAll:             updateAll,
			UpdateInfraFactsOnly:  updateInfraFactsOnly,
			CreateStateBucketOnly: createStateBucketOnly,
			InfracostToken:        infracostToken,
			Stdout:                os.Stdout,
			Stderr:                os.Stderr,
			ApiClient:             apiClient,
			DeploymentID:          deploymentID,
			RepoCreatePrompt: func(repoURL string) bool {
				createRepo := false
				prompt := &survey.Confirm{
					Message: fmt.Sprintf("Repository %s not found or is empty. Do you want to create it?", repoURL),
				}
				survey.AskOne(prompt, &createRepo)
				return createRepo
			},
		})

		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(deployCmd)
	deployCmd.Flags().BoolVar(&dryRun, "dry-run", false, "Run in dry-run mode without making actual changes")
	deployCmd.Flags().BoolVar(&createStateBucketOnly, "create-state-bucket-only", false, "Only create the state bucket if it does not exist, then exit.")
	deployCmd.Flags().BoolVar(&updateInfra, "update-infra", false, "Update (overwrite) infrastructure (terraform) repository")
	deployCmd.Flags().BoolVar(&updateGitOps, "update-gitops", false, "Update (overwrite) GitOps (argocd) repositories")
	deployCmd.Flags().BoolVar(&updateAll, "update-all", false, "Update both infrastructure and GitOps repositories")
	deployCmd.Flags().BoolVar(&updateInfraFactsOnly, "update-infra-facts-only", false, "Update only the infra-facts.yaml in the repositories")
	deployCmd.Flags().StringVar(&infracostToken, "infracost-token", "", "Infracost API token")
	deployCmd.Flags().StringVar(&awsProfile, "aws-profile", "default", "AWS profile to use")
	deployCmd.Flags().StringVar(&deployConfigFile, "config-file", "", "Path to a legacy-compatible installer YAML file")
}
