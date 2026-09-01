// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	jobsCancelYes      bool
	jobsCancelSelector jobSelector
)

var jobsCancelCmd = &cobra.Command{
	Use:   "cancel [job_id]",
	Short: "Cancel a queued or processing job",
	Long: `Cancel one job. The Runner sees the cancellation on its next status check and stops
the tofu process.

The id is optional, the same as ` + "`jobs get`" + ` and ` + "`jobs logs`" + `. Because cancelling is
destructive AND ` + "`--latest`" + ` picks the target for you, the resolved job is always named — in
the confirmation on a terminal, and on stdout before it acts when ` + "`--yes`" + ` skipped it.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		ref, err := resolveJob(apiClient, args, jobsCancelSelector)
		if err != nil {
			fail(err)
		}

		// A destructive command that resolved its own target must say what the target was. With
		// --yes there is no confirmation to carry it, so it is announced before the mutation.
		if jobsCancelYes {
			announceResolvedJob(ref, "Cancelling")
		}

		if !confirmDestructive(
			jobsCancelYes,
			fmt.Sprintf("Cancel job %s?", ref.ID),
			cancelJobWarning(ref),
		) {
			return
		}

		ui.RunSpinner("Cancelling job...", func() {
			err = apiClient.CancelJob(ref.ID)
		})

		if err != nil {
			failf("Failed to cancel job: %v", err)
		}

		ui.Success(fmt.Sprintf("Job %s cancelled", ref.ID))
	},
}

// cancelJobWarning is the confirmation's description: the consequence, plus which job this is
// when the CLI resolved it rather than being handed an id.
//
// The distinction is the point. "Cancel job 8f3c2a1e-…?" is not a question a person can answer
// when they never typed that id — the prompt has to show what --latest landed on.
func cancelJobWarning(ref jobRef) string {
	const consequence = "A running apply stops part-way, which can leave the environment between two states."
	if ref.Summary == "" {
		return consequence
	}
	return ref.Summary + "\n" + consequence
}

func init() {
	addYesFlag(jobsCancelCmd, &jobsCancelYes)
	addJobSelectorFlags(jobsCancelCmd, &jobsCancelSelector)
	jobsCmd.AddCommand(jobsCancelCmd)
}
