// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var (
	vineDestroyVineID    string
	vineDestroyTendrilID string
	vineDestroyWait      bool
)

var vineDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a spec's infrastructure",
	Long:  `Queues a DESTROY job to tear down all cloud resources for a spec. This cannot be undone.`,
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
					Title("Are you sure you want to destroy this spec?").
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
	vineDestroyCmd.Flags().StringVar(&vineDestroyVineID, "spec-id", "", "ID of the spec to destroy")
	vineDestroyCmd.Flags().StringVar(&vineDestroyTendrilID, "runner-id", "", "Assign to a specific runner")
	vineDestroyCmd.Flags().BoolVarP(&vineDestroyWait, "wait", "w", false, "Wait for job completion")
}
