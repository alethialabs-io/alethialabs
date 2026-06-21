// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
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
			fail(err)
		}

		zoneID := ""

		if specPlanSpecID == "" {
			zoneID, specPlanSpecID, err = selectZoneAndSpec(token)
			if err != nil {
				fail(err)
			}
		}

		if specPlanRunnerID == "" {
			specPlanRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
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
			failf("Error: %v", err)
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
