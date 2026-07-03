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
	projectPlanProjectID string
	projectPlanRunnerID  string
	projectPlanWait      bool
)

var projectPlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "Queue a plan (dry-run) job for a project",
	Long:  `Plan runs a Terraform plan with cost analysis without applying changes.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		if projectPlanProjectID == "" {
			projectPlanProjectID, err = selectProject(token)
			if err != nil {
				fail(err)
			}
		}

		if projectPlanRunnerID == "" {
			projectPlanRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "PLAN",
			ConfigurationID: projectPlanProjectID,
		}
		if projectPlanRunnerID != "" {
			params.AssignedRunnerID = projectPlanRunnerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectPlanWait {
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
	projectCmd.AddCommand(projectPlanCmd)
	projectPlanCmd.Flags().StringVar(&projectPlanProjectID, "project-id", "", "ID of the project to plan")
	projectPlanCmd.Flags().StringVar(&projectPlanRunnerID, "runner-id", "", "Assign to a specific runner")
	projectPlanCmd.Flags().BoolVarP(&projectPlanWait, "wait", "w", false, "Wait for job completion")
}
