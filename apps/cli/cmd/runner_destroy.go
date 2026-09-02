// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	destroyRunner           string
	destroyRunnerID         string
	destroyAssignedRunner   string
	destroyRunnerAssignedID string
	destroyRunnerWait       bool
	// destroyRunnerYes is the --yes opt-in: skip the confirmation prompt (and make
	// the command usable with --no-input).
	destroyRunnerYes bool
)

var runnerDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Tear down a runner's cloud infrastructure",
	Long: `Queues a DESTROY_RUNNER job to tear down the runner's cloud resources. Another runner will execute the teardown.

Name the runner with --runner, which takes its NAME as shown by "alethia runner list" — no id
has to be copied between commands. --runner-id still takes the raw id for scripts that already
pass one; passing both is refused rather than resolved by precedence.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)

		runnerID, err := runnerIDFrom(apiClient, destroyRunner, destroyRunnerID, "--runner", "--runner-id")
		if err != nil {
			fail(err)
		}
		if runnerID == "" {
			if noInputMode {
				failf("no runner given: pass --runner (its name or its id), or --runner-id")
			}
			runnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
			if runnerID == "" {
				// "Any available" is a valid answer for the EXECUTOR picker below and a meaningless
				// one here: there is no such thing as destroying any available runner.
				failf("Select a specific runner to destroy, not %q.", "Any available")
			}
		}

		// The executor is RESOLVED before the confirmation and PICKED after it. A command line
		// that names the executor twice, or names one that does not exist, is wrong whatever the
		// answer to "are you sure" would have been — asking first would make the user confirm a
		// teardown that was never going to run.
		assignedID, err := runnerIDFrom(apiClient, destroyAssignedRunner, destroyRunnerAssignedID,
			"--assigned-runner", "--assigned-runner-id")
		if err != nil {
			fail(err)
		}

		if !confirmDestructive(
			destroyRunnerYes,
			"Are you sure you want to destroy this runner?",
			"This will tear down the runner's cloud infrastructure. It cannot be undone.",
		) {
			return
		}

		// As in project destroy: the executor picker cannot be answered with prompting
		// disabled, and an empty id leaves the teardown job for any available runner.
		if assignedID == "" && !noInputMode {
			assignedID, err = selectRunner(token, runnerID)
			if err != nil {
				fail(err)
			}
		}

		snapshot := map[string]interface{}{
			"runner_id": runnerID,
		}

		params := api.QueueJobParams{
			JobType:          "DESTROY_RUNNER",
			ConfigSnapshot:   snapshot,
			AssignedRunnerID: assignedID,
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		ui.JobQueued("DESTROY_RUNNER", job.ID)
		if destroyRunnerWait {
			if err := waitForJob(apiClient, job.ID); err != nil {
				exitFunc(1)
			}
		}
	},
}

func init() {
	addYesFlag(runnerDestroyCmd, &destroyRunnerYes)
	runnerCmd.AddCommand(runnerDestroyCmd)
	runnerDestroyCmd.Flags().StringVar(&destroyRunner, "runner", "",
		"Runner to destroy, by NAME or id (asked for on a terminal when omitted)")
	runnerDestroyCmd.Flags().StringVar(&destroyRunnerID, "runner-id", "",
		"Runner id to destroy (prefer --runner, which also takes the name)")
	runnerDestroyCmd.Flags().StringVar(&destroyAssignedRunner, "assigned-runner", "",
		"Runner that executes the teardown, by NAME or id (any available when omitted)")
	runnerDestroyCmd.Flags().StringVar(&destroyRunnerAssignedID, "assigned-runner-id", "",
		"Runner id that executes the teardown (prefer --assigned-runner, which also takes the name)")
	runnerDestroyCmd.Flags().BoolVarP(&destroyRunnerWait, "wait", "w", false, "Wait for job completion")
}
