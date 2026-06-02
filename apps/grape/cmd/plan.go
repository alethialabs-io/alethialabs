package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

var (
	planVineID   string
	planWorkerID string
	planWait     bool
)

var planCmd = &cobra.Command{
	Use:   "plan",
	Short: "Queue a plan (dry-run) job for a vine",
	Long:  `Plan runs a Terraform plan with cost analysis without applying changes.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		vineyardID := ""

		if planVineID == "" {
			vineyardID, _, err = selectVineyard(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			planVineID, err = selectVine(token, vineyardID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		if vineyardID == "" {
			vineyardID = planVineID
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "PLAN",
			VineyardID:      vineyardID,
			ConfigurationID: planVineID,
		}
		if planWorkerID != "" {
			params.AssignedWorkerID = planWorkerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
		fmt.Printf("\n%s Queued PLAN job (ID: %s)\n", successStyle.Render("✓"), job.ID)

		if planWait {
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			fmt.Println("A worker will pick up this job. Monitor with `grape jobs logs " + job.ID + " --follow`")
		}
	},
}

func init() {
	rootCmd.AddCommand(planCmd)
	planCmd.Flags().StringVar(&planVineID, "vine-id", "", "ID of the vine to plan")
	planCmd.Flags().StringVar(&planWorkerID, "worker-id", "", "Assign to a specific worker")
	planCmd.Flags().BoolVarP(&planWait, "wait", "w", false, "Wait for job completion")
}
