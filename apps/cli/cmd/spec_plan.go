// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	specPlanSpecID   string
	specPlanRunnerID string
	specPlanWait     bool
)

var specPlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "Queue a plan (dry-run) job for a spec",
	Long:  `Plan runs a Terraform plan with cost analysis without applying changes.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		zoneID := ""

		if specPlanSpecID == "" {
			zoneID, _, err = selectZone(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			specPlanSpecID, err = selectSpec(token, zoneID)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		if specPlanRunnerID == "" {
			specPlanRunnerID, err = selectRunner(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "PLAN",
			ZoneID:          zoneID,
			ConfigurationID: specPlanSpecID,
		}
		if specPlanRunnerID != "" {
			params.AssignedRunnerID = specPlanRunnerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if specPlanWait {
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
	specCmd.AddCommand(specPlanCmd)
	specPlanCmd.Flags().StringVar(&specPlanSpecID, "spec-id", "", "ID of the spec to plan")
	specPlanCmd.Flags().StringVar(&specPlanRunnerID, "runner-id", "", "Assign to a specific runner")
	specPlanCmd.Flags().BoolVarP(&specPlanWait, "wait", "w", false, "Wait for job completion")
}
