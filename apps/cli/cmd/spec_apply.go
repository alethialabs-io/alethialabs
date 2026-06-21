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
	specApplySpecID    string
	specApplyRunnerID  string
	specApplyPlanJobID string
	specApplyWait      bool
)

var specApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply infrastructure changes for a spec",
	Long:  `Queues a DEPLOY job to provision or update a spec's infrastructure.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		zoneID := ""

		if specApplySpecID == "" {
			zoneID, specApplySpecID, err = selectZoneAndSpec(token)
			if err != nil {
				fail(err)
			}
		}

		if specApplyRunnerID == "" {
			specApplyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DEPLOY",
			ZoneID:          zoneID,
			ConfigurationID: specApplySpecID,
		}
		if specApplyRunnerID != "" {
			params.AssignedRunnerID = specApplyRunnerID
		}
		if specApplyPlanJobID != "" {
			params.PlanJobID = specApplyPlanJobID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if specApplyWait {
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
	specCmd.AddCommand(specApplyCmd)
	specApplyCmd.Flags().StringVar(&specApplySpecID, "spec-id", "", "ID of the spec to deploy")
	specApplyCmd.Flags().StringVar(&specApplyRunnerID, "runner-id", "", "Assign to a specific runner")
	specApplyCmd.Flags().StringVar(&specApplyPlanJobID, "plan-job-id", "", "Reference a prior PLAN job")
	specApplyCmd.Flags().BoolVarP(&specApplyWait, "wait", "w", false, "Wait for job completion")
}
