package cmd

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/provisioner"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
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

		if destroyVineyardID == "" {
			fmt.Println("Fetching your Vineyards...")
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
				fmt.Println("No Vineyards found.")
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

		err = provisioner.RunDestroy(context.Background(), provisioner.DestroyParams{
			VineyardID:       destroyVineyardID,
			VineyardName:     vineyardName,
			Environment:      environment,
			Region:           region,
			CleanupWorkspace: cleanupWorkspace,
			Stdout:           os.Stdout,
			Stderr:           os.Stderr,
			ApiClient:        apiClient,
		})

		if err != nil {
			log.Fatalf("Destroy failed: %v", err)
		}
	},
}

func init() {
	rootCmd.AddCommand(destroyCmd)
	destroyCmd.Flags().StringVarP(&destroyVineyardID, "vineyard-id", "v", "", "ID of the Vineyard")
	destroyCmd.Flags().StringVarP(&environment, "environment", "e", "dev", "Environment name (e.g., dev, prod)")
	destroyCmd.Flags().BoolVar(&cleanupWorkspace, "cleanup", true, "Remove workspace directory after destruction")
}
