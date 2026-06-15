// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
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
	vinePlanVineID     string
	vinePlanTendrilID  string
	vinePlanWait       bool
)

var vinePlanCmd = &cobra.Command{
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

		if vinePlanVineID == "" {
			vineyardID, _, err = selectVineyard(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			vinePlanVineID, err = selectVine(token, vineyardID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		if vinePlanTendrilID == "" {
			vinePlanTendrilID, err = selectTendril(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "PLAN",
			VineyardID:      vineyardID,
			ConfigurationID: vinePlanVineID,
		}
		if vinePlanTendrilID != "" {
			params.AssignedWorkerID = vinePlanTendrilID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if vinePlanWait {
			ui.JobQueued("PLAN", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				os.Exit(1)
			}
		} else {
			ui.JobQueued("PLAN", job.ID)
		}
	},
}

func init() {
	vineCmd.AddCommand(vinePlanCmd)
	vinePlanCmd.Flags().StringVar(&vinePlanVineID, "vine-id", "", "ID of the vine to plan")
	vinePlanCmd.Flags().StringVar(&vinePlanTendrilID, "tendril-id", "", "Assign to a specific tendril")
	vinePlanCmd.Flags().BoolVarP(&vinePlanWait, "wait", "w", false, "Wait for job completion")
}
