package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

var (
	harvestVineID   string
	harvestWorkerID string
	harvestPlanJob  string
	harvestWait     bool
)

var harvestCmd = &cobra.Command{
	Use:   "harvest",
	Short: "Queue a deploy job for a vine",
	Long:  `Harvest triggers provisioning of a vine by queuing a DEPLOY job for a worker to execute.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		vineyardID := ""

		if harvestVineID == "" {
			vineyardID, _, err = selectVineyard(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			harvestVineID, err = selectVine(token, vineyardID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		if vineyardID == "" {
			vineyardID = harvestVineID
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DEPLOY",
			VineyardID:      vineyardID,
			ConfigurationID: harvestVineID,
		}
		if harvestWorkerID != "" {
			params.AssignedWorkerID = harvestWorkerID
		}
		if harvestPlanJob != "" {
			params.PlanJobID = harvestPlanJob
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
		fmt.Printf("\n%s Queued DEPLOY job (ID: %s)\n", successStyle.Render("✓"), job.ID)

		if harvestWait {
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			fmt.Println("A worker will pick up this job. Monitor with `grape jobs logs " + job.ID + " --follow`")
		}
	},
}

func init() {
	rootCmd.AddCommand(harvestCmd)
	harvestCmd.Flags().StringVar(&harvestVineID, "vine-id", "", "ID of the vine to deploy")
	harvestCmd.Flags().StringVar(&harvestWorkerID, "worker-id", "", "Assign to a specific worker")
	harvestCmd.Flags().StringVar(&harvestPlanJob, "plan-job-id", "", "Reference a prior PLAN job")
	harvestCmd.Flags().BoolVarP(&harvestWait, "wait", "w", false, "Wait for job completion")
}
