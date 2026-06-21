// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var jobsCancelCmd = &cobra.Command{
	Use:   "cancel <job_id>",
	Short: "Cancel a queued or processing job",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		jobID := args[0]

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)

		spinner.New().
			Title("Cancelling job...").
			Action(func() {
				err = apiClient.CancelJob(jobID)
			}).Run()

		if err != nil {
			failf("Failed to cancel job: %v", err)
		}

		ui.Success(fmt.Sprintf("Job %s cancelled", jobID))
	},
}

func init() {
	jobsCmd.AddCommand(jobsCancelCmd)
}
