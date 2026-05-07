package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/charmbracelet/lipgloss"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
)

var (
	harvestVineyardID string
	harvestVineID     string
	harvestClusterID  string
)

var harvestCmd = &cobra.Command{
	Use:   "harvest",
	Short: "Trigger a harvest (provisioning) of a vine",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
		if webOrigin == "" {
			webOrigin = "https://adp.prod.itgix.eu"
		}
		reqClient := req.C()

		// Interactive selection if missing IDs
		if harvestVineID == "" || harvestClusterID == "" {
			// 1. Fetch Vineyards
			var vResult struct {
				Vineyards []types.Vineyard `json:"vineyards"`
			}
			
			spinner.New().
				Title("Fetching vineyards...").
				Action(func() {
					_, err = reqClient.R().
						SetBearerAuthToken(token).
						SetSuccessResult(&vResult).
						Get(fmt.Sprintf("%s/api/cli/vineyards", webOrigin))
				}).Run()

			if len(vResult.Vineyards) == 0 {
				fmt.Println("No vineyards found. Create one first.")
				return
			}

			vOptions := make([]huh.Option[string], len(vResult.Vineyards))
			for i, v := range vResult.Vineyards {
				vOptions[i] = huh.NewOption(v.Name, v.ID)
			}

			err = huh.NewForm(
				huh.NewGroup(
					huh.NewSelect[string]().
						Title("Select Vineyard").
						Options(vOptions...).
						Value(&harvestVineyardID),
				),
			).Run()

			if err != nil { return }

			// 2. Fetch Vines and Clusters for this Vineyard
			var configsResult struct {
				Configurations []types.ConfigurationSummary `json:"configurations"`
			}
			var clustersResult struct {
				Clusters []api.Cluster `json:"clusters"`
			}

			spinner.New().
				Title("Fetching vines and clusters...").
				Action(func() {
					// Configurations (Vines)
					_, _ = reqClient.R().
						SetBearerAuthToken(token).
						SetSuccessResult(&configsResult).
						Get(fmt.Sprintf("%s/api/cli/configurations", webOrigin))
					
					// Clusters (Tendrils)
					_, _ = reqClient.R().
						SetBearerAuthToken(token).
						SetSuccessResult(&clustersResult).
						Get(fmt.Sprintf("%s/api/cli/clusters", webOrigin))
				}).Run()

			// Filter vines by vineyard
			vineOptions := []huh.Option[string]{}
			for _, c := range configsResult.Configurations {
				if c.VineyardID != nil && *c.VineyardID == harvestVineyardID {
					vineOptions = append(vineOptions, huh.NewOption(c.ProjectName, c.ID))
				}
			}

			if len(vineOptions) == 0 {
				fmt.Println("No vines found in this vineyard. Grow one first.")
				return
			}

			// Filter clusters by vineyard
			clusterOptions := []huh.Option[string]{}
			for _, c := range clustersResult.Clusters {
				// Note: In real app, check if cluster belongs to vineyard
				clusterOptions = append(clusterOptions, huh.NewOption(fmt.Sprintf("%s (%s)", c.Name, c.Status), c.ID))
			}

			if len(clusterOptions) == 0 {
				fmt.Println("No clusters (Tendrils) found. Bootstrap one first.")
				return
			}

			err = huh.NewForm(
				huh.NewGroup(
					huh.NewSelect[string]().
						Title("Select Vine to Harvest").
						Options(vineOptions...).
						Value(&harvestVineID),
					huh.NewSelect[string]().
						Title("Select Target Cluster").
						Options(clusterOptions...).
						Value(&harvestClusterID),
				),
			).Run()

			if err != nil { return }
		}

		// Trigger Harvest
		var hResult struct {
			Harvest types.Harvest `json:"harvest"`
		}
		var errMsg struct {
			Error string `json:"error"`
		}

		action := func() {
			_, err = reqClient.R().
				SetBearerAuthToken(token).
				SetBody(map[string]string{
					"vine_id":    harvestVineID,
					"cluster_id": harvestClusterID,
				}).
				SetSuccessResult(&hResult).
				SetErrorResult(&errMsg).
				Post(fmt.Sprintf("%s/api/cli/harvests", webOrigin))
		}

		err = spinner.New().
			Title("Queuing harvest...").
			Action(action).
			Run()

		if err != nil {
			fmt.Printf("Error: %v\n", err)
			return
		}

		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
		fmt.Printf("\n%s Successfully queued harvest (ID: %s)\n", successStyle.Render("✓"), hResult.Harvest.ID)
		fmt.Println("Tendril agent will pick this up shortly. Monitor progress in Trellis.")
	},
}

func init() {
	rootCmd.AddCommand(harvestCmd)
	harvestCmd.Flags().StringVar(&harvestVineID, "vine-id", "", "ID of the vine to harvest")
	harvestCmd.Flags().StringVar(&harvestClusterID, "cluster-id", "", "ID of the target cluster")
}
