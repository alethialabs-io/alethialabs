// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	destroyRunner           string
	destroyRunnerID         string
	destroyAssignedRunner   string
	destroyRunnerAssignedID string
	// destroyRunnerWait is --wait and --timeout.
	destroyRunnerWait waitFlags
	// destroyRunnerYes is the --yes opt-in: skip the confirmation prompt (and make
	// the command usable with --no-input).
	destroyRunnerYes bool
)

// runnerDestroyJobType is the job a runner destroy queues.
const runnerDestroyJobType = "DESTROY_RUNNER"

var runnerDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Tear down a deployed runner's cloud resources",
	Long: `Queues a DESTROY_RUNNER job, which tears down the cloud resources "alethia runner deploy"
built for a runner. It cannot be undone.

Use it for a runner Alethia deployed. A runner you registered and run yourself has nothing here
to tear down: stop its process and use "alethia runner remove".

A runner cannot tear itself down, so another runner that is online (or the managed fleet) runs
the job. With neither, the command refuses before a job is queued.

Name the runner with --runner, which takes its name as "alethia runner list" shows it. On a
terminal you type the runner's name to confirm. With nobody to ask, pass --yes; without it the
command refuses and changes nothing. --dry-run checks every input and prints the request
without sending it.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runRunnerDestroy(cmd); err != nil {
			fail(err)
		}
	},
}

// runnerDestroyClient is what `runner destroy` asks the control plane.
type runnerDestroyClient interface {
	runnerSource
	jobPoller
	QueueJobWithParams(params api.QueueJobParams) (*api.ProvisionJob, error)
}

// runRunnerDestroy is `runner destroy` up to authentication.
func runRunnerDestroy(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	result, ok, err := destroyRunnerJob(ctx, printer, api.NewClient(token), token, cmdmeta.DryRunRequested(cmd))
	if err != nil || !ok {
		return err
	}
	return printRunnerJob(cmd, result)
}

// destroyRunnerJob resolves the runner and its executor, confirms, and queues the teardown — or,
// on a dry run, returns the request it would have sent. The bool is false when the person
// declined the confirmation: nothing was queued and there is nothing to print.
func destroyRunnerJob(ctx context.Context, p *Printer, c runnerDestroyClient, token string, dryRun bool) (MutationResult, bool, error) {
	result := MutationResult{Kind: "runner", Action: ResultQueued, DryRun: dryRun}

	list, err := c.GetRunners()
	if err != nil {
		return result, false, fmt.Errorf("list runners: %w", err)
	}
	runnerID, err := runnerIDFrom(runnerList(list), destroyRunner, destroyRunnerID, "--runner", "--runner-id")
	if err != nil {
		return result, false, err
	}
	if runnerID == "" {
		if runnerID, err = pickRunnerToEnd(token, "destroy", "--runner (its name or its id), or --runner-id"); err != nil {
			return result, false, err
		}
	}
	result.ID = runnerID

	// The executor is RESOLVED before the confirmation and PICKED after it. A command line
	// that names the executor twice, or names one that does not exist, is wrong whatever the
	// answer to "are you sure" would have been — asking first would make the user confirm a
	// teardown that was never going to run.
	assignedID, err := runnerIDFrom(runnerList(list), destroyAssignedRunner, destroyRunnerAssignedID,
		"--assigned-runner", "--assigned-runner-id")
	if err != nil {
		return result, false, err
	}
	// The picker below already refuses to OFFER the runner being destroyed (selectRunner takes
	// it as excludeID). The flag path has to encode the same exclusion, or the two halves of one
	// field disagree. A runner tearing down its own cloud resources mid-job does not fail
	// cleanly: the control plane sees a DESTROY_RUNNER that stops reporting.
	if assignedID != "" && assignedID == runnerID {
		return result, false, refusal(clierr.CodeInvalidUsage, "alethia runner list",
			"--assigned-runner names the runner being destroyed; pick another executor, or omit it to let the control plane choose")
	}
	if err := runnerJobExecutor(c, list, "tear this runner down", assignedID, runnerID); err != nil {
		return result, false, err
	}

	obj := runnerJobObject{Warnings: []string{}}
	if r, ok := runnerByID(list, runnerID); ok {
		obj.Name = r.Name
	}
	if dryRun {
		obj.Request = &runnerJobRequest{
			JobType: runnerDestroyJobType, RunnerID: runnerID, AssignedRunnerID: assignedID,
		}
		result.Object = obj
		return result, true, nil
	}

	ok, err := confirmDestructiveByName(destroyRunnerYes,
		"Destroy this runner?",
		"This tears down the runner's cloud resources. It cannot be undone.",
		func() string { return runnerConfirmName(list, runnerID) })
	if err != nil || !ok {
		return result, false, err
	}

	// As in project destroy: the executor picker cannot be answered with prompting
	// disabled, and an empty id leaves the teardown job for any runner that is online.
	if assignedID == "" && canPromptForm() {
		if assignedID, err = selectRunner(token, runnerID); err != nil {
			return result, false, err
		}
	}

	job, err := c.QueueJobWithParams(api.QueueJobParams{
		JobType:          runnerDestroyJobType,
		ConfigSnapshot:   map[string]interface{}{"runner_id": runnerID},
		AssignedRunnerID: assignedID,
	})
	if err != nil {
		return result, false, fmt.Errorf("queue the teardown of runner %s: %w", runnerConfirmName(list, runnerID), err)
	}
	if job == nil {
		return result, false, clierr.New(clierr.CodeInternal,
			"the control plane accepted the request and named no job, so there is nothing to follow")
	}
	result.Job = &JobRef{ID: job.ID, Type: runnerDestroyJobType}
	obj.JobStatus = job.Status

	if err := followRunnerJob(ctx, p, c, destroyRunnerWait, *result.Job, &obj); err != nil {
		return result, false, err
	}
	result.Object = obj
	return result, true, nil
}

func init() {
	addYesFlag(runnerDestroyCmd, &destroyRunnerYes)
	runnerCmd.AddCommand(runnerDestroyCmd)
	runnerDestroyCmd.Flags().StringVar(&destroyRunner, "runner", "",
		"Runner to destroy, by NAME or id (asked for on a terminal when omitted)")
	runnerDestroyCmd.Flags().StringVar(&destroyRunnerID, "runner-id", "",
		"Runner id to destroy (prefer --runner, which also takes the name)")
	runnerDestroyCmd.Flags().StringVar(&destroyAssignedRunner, "assigned-runner", "",
		"Runner that executes the teardown, by NAME or id (any that is online when omitted)")
	runnerDestroyCmd.Flags().StringVar(&destroyRunnerAssignedID, "assigned-runner-id", "",
		"Runner id that executes the teardown (prefer --assigned-runner, which also takes the name)")
	addProjectWaitFlags(runnerDestroyCmd, &destroyRunnerWait)
	addDryRunFlag(runnerDestroyCmd)
}
