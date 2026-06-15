package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/api"
	"github.com/charmbracelet/huh"
	"github.com/bobikenobi12/bb-thesis-2026/apps/vtx/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var (
	vineDestroyVineID    string
	vineDestroyTendrilID string
	vineDestroyWait      bool
)

var vineDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a vine's infrastructure",
	Long:  `Queues a DESTROY job to tear down all cloud resources for a vine. This cannot be undone.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		vineyardID := ""

		if vineDestroyVineID == "" {
			vineyardID, _, err = selectVineyard(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			vineDestroyVineID, err = selectVine(token, vineyardID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
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

		if vineDestroyTendrilID == "" {
			vineDestroyTendrilID, err = selectTendril(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DESTROY",
			VineyardID:      vineyardID,
			ConfigurationID: vineDestroyVineID,
		}
		if vineDestroyTendrilID != "" {
			params.AssignedWorkerID = vineDestroyTendrilID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if vineDestroyWait {
			ui.JobQueued("DESTROY", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("DESTROY", job.ID)
		}
	},
}

func init() {
	vineCmd.AddCommand(vineDestroyCmd)
	vineDestroyCmd.Flags().StringVar(&vineDestroyVineID, "vine-id", "", "ID of the vine to destroy")
	vineDestroyCmd.Flags().StringVar(&vineDestroyTendrilID, "tendril-id", "", "Assign to a specific tendril")
	vineDestroyCmd.Flags().BoolVarP(&vineDestroyWait, "wait", "w", false, "Wait for job completion")
}
