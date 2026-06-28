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
	projectApplyProjectID string
	projectApplyRunnerID  string
	projectApplyPlanJobID string
	projectApplyWait      bool
)

var projectApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply infrastructure changes for a project",
	Long:  `Queues a DEPLOY job to provision or update a project's infrastructure.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		if projectApplyProjectID == "" {
			projectApplyProjectID, err = selectProject(token)
			if err != nil {
				fail(err)
			}
		}

		if projectApplyRunnerID == "" {
			projectApplyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DEPLOY",
			ConfigurationID: projectApplyProjectID,
		}
		if projectApplyRunnerID != "" {
			params.AssignedRunnerID = projectApplyRunnerID
		}
		if projectApplyPlanJobID != "" {
			params.PlanJobID = projectApplyPlanJobID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectApplyWait {
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
	projectCmd.AddCommand(projectApplyCmd)
	projectApplyCmd.Flags().StringVar(&projectApplyProjectID, "project-id", "", "ID of the project to deploy")
	projectApplyCmd.Flags().StringVar(&projectApplyRunnerID, "runner-id", "", "Assign to a projectific runner")
	projectApplyCmd.Flags().StringVar(&projectApplyPlanJobID, "plan-job-id", "", "Reference a prior PLAN job")
	projectApplyCmd.Flags().BoolVarP(&projectApplyWait, "wait", "w", false, "Wait for job completion")
}
