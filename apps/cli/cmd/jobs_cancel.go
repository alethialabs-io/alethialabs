// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var jobsCancelYes bool

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
		if !confirmDestructive(
			jobsCancelYes,
			fmt.Sprintf("Cancel job %s?", jobID),
			"A running apply stops part-way, which can leave the environment between two states.",
		) {
			return
		}

		apiClient := api.NewClient(token)

		ui.RunSpinner("Cancelling job...", func() {
			err = apiClient.CancelJob(jobID)
		})

		if err != nil {
			failf("Failed to cancel job: %v", err)
		}

		ui.Success(fmt.Sprintf("Job %s cancelled", jobID))
	},
}

func init() {
	addYesFlag(jobsCancelCmd, &jobsCancelYes)
	jobsCmd.AddCommand(jobsCancelCmd)
}
