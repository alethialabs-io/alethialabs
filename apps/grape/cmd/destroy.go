package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

var destroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy infrastructure resources",
	Long:  `Destroy vines or workers by queuing a teardown job for a worker to execute.`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `grape destroy vine` or `grape destroy worker`")
	},
}

var (
	destroyVineID     string
	destroyWorkerFlag string
	destroyAssignedID string
	destroyWait       bool
)

var destroyVineCmd = &cobra.Command{
	Use:   "vine",
	Short: "Queue a DESTROY job for a vine",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		vineyardID := ""

		if destroyVineID == "" {
			vineyardID, _, err = selectVineyard(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			destroyVineID, err = selectVine(token, vineyardID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		if vineyardID == "" {
			vineyardID = destroyVineID
		}

		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Are you sure you want to destroy this vine?").
					Description("This will tear down all cloud resources. It cannot be undone.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DESTROY",
			VineyardID:      vineyardID,
			ConfigurationID: destroyVineID,
		}
		if destroyAssignedID != "" {
			params.AssignedWorkerID = destroyAssignedID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
		fmt.Printf("\n%s Queued DESTROY job (ID: %s)\n", successStyle.Render("✓"), job.ID)

		if destroyWait {
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			fmt.Println("A worker will pick up this job. Monitor with `grape jobs logs " + job.ID + " --follow`")
		}
	},
}

var (
	destroyWorkerID         string
	destroyWorkerAssignedID string
	destroyWorkerWait       bool
)

var destroyWorkerCmd = &cobra.Command{
	Use:   "worker",
	Short: "Queue a DESTROY_WORKER job to tear down a deployed worker",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		if destroyWorkerID == "" {
			destroyWorkerID, err = selectWorker(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Are you sure you want to destroy this worker?").
					Description("This will tear down the worker's cloud infrastructure.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		apiClient := api.NewClient(token)

		snapshot := map[string]interface{}{
			"worker_id": destroyWorkerID,
		}

		params := api.QueueJobParams{
			JobType:        "DESTROY_WORKER",
			VineyardID:     "",
			ConfigSnapshot: snapshot,
		}
		if destroyWorkerAssignedID != "" {
			params.AssignedWorkerID = destroyWorkerAssignedID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
		fmt.Printf("\n%s Queued DESTROY_WORKER job (ID: %s)\n", successStyle.Render("✓"), job.ID)

		if destroyWorkerWait {
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			fmt.Println("A worker will pick up this job. Monitor with `grape jobs logs " + job.ID + " --follow`")
		}
	},
}

func init() {
	rootCmd.AddCommand(destroyCmd)
	destroyCmd.AddCommand(destroyVineCmd)
	destroyCmd.AddCommand(destroyWorkerCmd)

	destroyVineCmd.Flags().StringVar(&destroyVineID, "vine-id", "", "ID of the vine to destroy")
	destroyVineCmd.Flags().StringVar(&destroyAssignedID, "worker-id", "", "Assign to a specific worker")
	destroyVineCmd.Flags().BoolVarP(&destroyWait, "wait", "w", false, "Wait for job completion")

	destroyWorkerCmd.Flags().StringVar(&destroyWorkerID, "worker-id", "", "ID of the worker to destroy")
	destroyWorkerCmd.Flags().StringVar(&destroyWorkerAssignedID, "assigned-worker-id", "", "Which worker executes the teardown")
	destroyWorkerCmd.Flags().BoolVarP(&destroyWorkerWait, "wait", "w", false, "Wait for job completion")
}
