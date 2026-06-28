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
	projectDestroyProjectID string
	projectDestroyRunnerID  string
	projectDestroyWait      bool
)

var projectDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a project's infrastructure",
	Long:  `Queues a DESTROY job to tear down all cloud resources for a project. This cannot be undone.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		if projectDestroyProjectID == "" {
			projectDestroyProjectID, err = selectProject(token)
			if err != nil {
				fail(err)
			}
		}

		if !confirm(
			"Are you sure you want to destroy this project?",
			"This will tear down all cloud resources. It cannot be undone.",
		) {
			return
		}

		if projectDestroyRunnerID == "" {
			projectDestroyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		params := api.QueueJobParams{
			JobType:         "DESTROY",
			ConfigurationID: projectDestroyProjectID,
		}
		if projectDestroyRunnerID != "" {
			params.AssignedRunnerID = projectDestroyRunnerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectDestroyWait {
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
	projectCmd.AddCommand(projectDestroyCmd)
	projectDestroyCmd.Flags().StringVar(&projectDestroyProjectID, "project-id", "", "ID of the project to destroy")
	projectDestroyCmd.Flags().StringVar(&projectDestroyRunnerID, "runner-id", "", "Assign to a projectific runner")
	projectDestroyCmd.Flags().BoolVarP(&projectDestroyWait, "wait", "w", false, "Wait for job completion")
}
