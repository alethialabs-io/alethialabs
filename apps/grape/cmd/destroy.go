package cmd

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/terraform"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	cleanupWorkspace bool
)

var destroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a bootstrapped environment",
	Long:  `Destroy removes all resources associated with a specific project and environment.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			log.Fatalf("Authentication failed: %v", err)
		}

		// Interactive Mode if project name is missing
		if projectName == "" {
			form := huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Project Name").
						Description("Enter the name of the project to destroy").
						Value(&projectName),
					huh.NewSelect[string]().
						Title("Environment").
						Options(
							huh.NewOption("Development", "dev"),
							huh.NewOption("Staging", "staging"),
							huh.NewOption("Production", "prod"),
						).Value(&environment),
				),
			)

			err := form.Run()
			if err != nil {
				fmt.Println("Cancelled.")
				return
			}
		}

		// Confirm destruction
		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Are you sure you want to destroy %s-%s?", projectName, environment)).
					Description("This action will remove all cloud resources and unregister the cluster from Trellis. It cannot be undone.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("Failed to get home directory: %v", err)
		}

		workDir := filepath.Join(home, ".grape", "workspaces", fmt.Sprintf("%s-%s", projectName, environment))
		if _, err := os.Stat(workDir); os.IsNotExist(err) {
			log.Fatalf("Workspace directory not found: %s", workDir)
		}

		fmt.Printf("🔥 Destroying environment %s-%s...\n", projectName, environment)

		// 1. Unregister Cluster from Trellis
		fmt.Println("   🔐 Unregistering cluster from Trellis...")
		client := api.NewClient(token)
		clusterName := fmt.Sprintf("%s-%s-cluster", projectName, environment)
		if err := client.UnregisterCluster("", clusterName); err != nil {
			fmt.Printf("      ⚠️ Warning: Failed to unregister cluster from Trellis: %v\n", err)
			fmt.Println("      Continuing with resource destruction...")
		} else {
			fmt.Println("      Cluster unregistered successfully.")
		}

		// 2. Initialize Terraform
		tf, err := terraform.NewTF_CLI("1.7.4")
		if err != nil {
			log.Fatalf("Failed to initialize Terraform CLI: %v", err)
		}

		// 3. Run Destroy
		// We assume terraform.tfvars already exists in the workspace from bootstrap
		fmt.Println("   ⚡ Destroying Cloud Resources (this may take 10-15 mins)...")
		if err := tf.Destroy(workDir, "terraform.tfvars"); err != nil {
			log.Fatalf("Terraform destroy failed: %v", err)
		}

		// 4. Cleanup workspace directory
		if cleanupWorkspace {
			fmt.Println("   🧹 Cleaning up workspace directory...")
			if err := os.RemoveAll(workDir); err != nil {
				fmt.Printf("      ⚠️ Warning: Failed to remove workspace directory: %v\n", err)
			} else {
				fmt.Println("      Workspace directory removed.")
			}
		}

		fmt.Println("✅ Environment destroyed successfully!")
	},
}

func init() {
	rootCmd.AddCommand(destroyCmd)
	destroyCmd.Flags().StringVarP(&projectName, "project-name", "p", "", "Name of the project")
	destroyCmd.Flags().StringVarP(&environment, "environment", "e", "dev", "Environment name (e.g., dev, prod)")
	destroyCmd.Flags().BoolVar(&cleanupWorkspace, "cleanup", true, "Remove workspace directory after destruction")
}
