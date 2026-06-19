// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	destroyRunnerID         string
	destroyRunnerAssignedID string
	destroyRunnerWait       bool
)

var runnerDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Tear down a runner's cloud infrastructure",
	Long:  `Queues a DESTROY_RUNNER job to tear down the runner's cloud resources. Another runner will execute the teardown.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		if destroyRunnerID == "" {
			destroyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
			if destroyRunnerID == "" {
				fmt.Println("Please select a specific runner to destroy, not 'Any available'.")
				os.Exit(1)
			}
		}

		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Are you sure you want to destroy this runner?").
					Description("This will tear down the runner's cloud infrastructure. It cannot be undone.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		if destroyRunnerAssignedID == "" {
			destroyRunnerAssignedID, err = selectRunner(token, destroyRunnerID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		snapshot := map[string]interface{}{
			"runner_id": destroyRunnerID,
		}

		params := api.QueueJobParams{
			JobType:          "DESTROY_RUNNER",
			ConfigSnapshot:   snapshot,
			AssignedRunnerID: destroyRunnerAssignedID,
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if destroyRunnerWait {
			ui.JobQueued("DESTROY_RUNNER", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("DESTROY_RUNNER", job.ID)
		}
	},
}

func init() {
	runnerCmd.AddCommand(runnerDestroyCmd)
	runnerDestroyCmd.Flags().StringVar(&destroyRunnerID, "runner-id", "", "ID of the runner to destroy")
	runnerDestroyCmd.Flags().StringVar(&destroyRunnerAssignedID, "assigned-runner-id", "", "Which runner executes the teardown")
	runnerDestroyCmd.Flags().BoolVarP(&destroyRunnerWait, "wait", "w", false, "Wait for job completion")
}
