// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
	destroyTendrilID         string
	destroyTendrilAssignedID string
	destroyTendrilWait       bool
)

var tendrilDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Tear down a tendril's cloud infrastructure",
	Long:  `Queues a DESTROY_WORKER job to tear down the tendril's cloud resources. Another tendril will execute the teardown.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		if destroyTendrilID == "" {
			destroyTendrilID, err = selectTendril(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
			if destroyTendrilID == "" {
				fmt.Println("Please select a specific tendril to destroy, not 'Any available'.")
				os.Exit(1)
			}
		}

		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Are you sure you want to destroy this tendril?").
					Description("This will tear down the tendril's cloud infrastructure. It cannot be undone.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		if destroyTendrilAssignedID == "" {
			destroyTendrilAssignedID, err = selectTendril(token, destroyTendrilID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		snapshot := map[string]interface{}{
			"worker_id": destroyTendrilID,
		}

		params := api.QueueJobParams{
			JobType:          "DESTROY_WORKER",
			ConfigSnapshot:   snapshot,
			AssignedWorkerID: destroyTendrilAssignedID,
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if destroyTendrilWait {
			ui.JobQueued("DESTROY_WORKER", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("DESTROY_WORKER", job.ID)
		}
	},
}

func init() {
	tendrilCmd.AddCommand(tendrilDestroyCmd)
	tendrilDestroyCmd.Flags().StringVar(&destroyTendrilID, "tendril-id", "", "ID of the tendril to destroy")
	tendrilDestroyCmd.Flags().StringVar(&destroyTendrilAssignedID, "assigned-tendril-id", "", "Which tendril executes the teardown")
	tendrilDestroyCmd.Flags().BoolVarP(&destroyTendrilWait, "wait", "w", false, "Wait for job completion")
}
