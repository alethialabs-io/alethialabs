// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var (
	vineApplyVineID    string
	vineApplyTendrilID string
	vineApplyPlanJobID string
	vineApplyWait      bool
)

var vineApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply infrastructure changes for a vine",
	Long:  `Queues a DEPLOY job to provision or update a vine's infrastructure.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		vineyardID := ""

		if vineApplyVineID == "" {
			vineyardID, _, err = selectVineyard(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			vineApplyVineID, err = selectVine(token, vineyardID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		if vineApplyTendrilID == "" {
			vineApplyTendrilID, err = selectTendril(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DEPLOY",
			VineyardID:      vineyardID,
			ConfigurationID: vineApplyVineID,
		}
		if vineApplyTendrilID != "" {
			params.AssignedWorkerID = vineApplyTendrilID
		}
		if vineApplyPlanJobID != "" {
			params.PlanJobID = vineApplyPlanJobID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if vineApplyWait {
			ui.JobQueued("DEPLOY", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("DEPLOY", job.ID)
		}
	},
}

func init() {
	vineCmd.AddCommand(vineApplyCmd)
	vineApplyCmd.Flags().StringVar(&vineApplyVineID, "vine-id", "", "ID of the vine to deploy")
	vineApplyCmd.Flags().StringVar(&vineApplyTendrilID, "tendril-id", "", "Assign to a specific tendril")
	vineApplyCmd.Flags().StringVar(&vineApplyPlanJobID, "plan-job-id", "", "Reference a prior PLAN job")
	vineApplyCmd.Flags().BoolVarP(&vineApplyWait, "wait", "w", false, "Wait for job completion")
}
