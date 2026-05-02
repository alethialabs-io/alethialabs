package cmd

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/terraform"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
	"github.com/charmbracelet/huh"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
)

var (
	destroyVineyardID string
	cleanupWorkspace  bool
)

var destroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a bootstrapped environment",
	Long:  `Destroy removes all resources associated with a specific vineyard and environment.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			log.Fatalf("Authentication failed: %v", err)
		}

		var vineyardName string
		apiClient := api.NewClient(token)

		// Interactive Mode if vineyard ID is missing
		if destroyVineyardID == "" {
			fmt.Println("🔍 Fetching your Vineyards...")
			var vResult struct {
				Vineyards []types.Vineyard `json:"vineyards"`
			}
			webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
			if webOrigin == "" {
				webOrigin = "https://adp.prod.itgix.eu"
			}
			reqClient := req.C()
			_, err := reqClient.R().
				SetBearerAuthToken(token).
				SetSuccessResult(&vResult).
				Get(fmt.Sprintf("%s/api/cli/vineyards", webOrigin))

			var vineyardOptions []huh.Option[string]
			if err == nil && len(vResult.Vineyards) > 0 {
				for _, v := range vResult.Vineyards {
					vineyardOptions = append(vineyardOptions, huh.NewOption(v.Name, v.ID))
				}
			}

			if len(vineyardOptions) == 0 {
				fmt.Println("❌ No Vineyards found.")
				return
			}

			form := huh.NewForm(
				huh.NewGroup(
					huh.NewSelect[string]().
						Title("Vineyard Workspace").
						Description("Select the Vineyard to destroy").
						Options(vineyardOptions...).
						Value(&destroyVineyardID),
					huh.NewSelect[string]().
						Title("Environment").
						Options(
							huh.NewOption("Development", "dev"),
							huh.NewOption("Staging", "staging"),
							huh.NewOption("Production", "prod"),
						).Value(&environment),
				),
			)

			err = form.Run()
			if err != nil {
				fmt.Println("Cancelled.")
				return
			}

			for _, v := range vResult.Vineyards {
				if v.ID == destroyVineyardID {
					vineyardName = v.Name
					break
				}
			}
		}

		// Confirm destruction
		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Are you sure you want to destroy %s-%s?", destroyVineyardID, environment)).
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

		workspaceName := fmt.Sprintf("%s-%s", vineyardName, environment)
		if vineyardName == "" {
			workspaceName = fmt.Sprintf("%s-%s", destroyVineyardID, environment)
		}

		workDir := filepath.Join(home, ".grape", "workspaces", workspaceName)
		if _, err := os.Stat(workDir); os.IsNotExist(err) {
			log.Fatalf("Workspace directory not found: %s", workDir)
		}

		fmt.Printf("🔥 Destroying environment %s...\n", workspaceName)

		// 1. Unregister Cluster from Trellis
		fmt.Println("   🔐 Unregistering cluster from Trellis...")
		clusterName := fmt.Sprintf("%s-cluster", workspaceName)
		if err := apiClient.UnregisterCluster("", clusterName); err != nil {
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
	destroyCmd.Flags().StringVarP(&destroyVineyardID, "vineyard-id", "v", "", "ID of the Vineyard")
	destroyCmd.Flags().StringVarP(&environment, "environment", "e", "dev", "Environment name (e.g., dev, prod)")
	destroyCmd.Flags().BoolVar(&cleanupWorkspace, "cleanup", true, "Remove workspace directory after destruction")
}
