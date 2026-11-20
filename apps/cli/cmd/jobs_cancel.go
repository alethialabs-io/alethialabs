// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"net/http"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
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
	Short: "Cancel a queued or running job",
	Long: `Cancel one job. The Runner sees the cancellation on its next status check and stops
the tofu process. Use it to stop a deploy or a plan that was started by mistake; a job that has
already finished cannot be cancelled, and the command says so with exit 7.

The id is optional, the same as ` + "`jobs get`" + ` and ` + "`jobs logs`" + `. Because cancelling is
destructive AND ` + "`--latest`" + ` picks the target for you, the resolved job is always named — in
the confirmation on a terminal, and on stderr before it acts when ` + "`--yes`" + ` skipped it.

Without an explicit ` + "`--status`" + `, ` + "`--latest`" + ` and the picker consider only jobs that can still be
cancelled (QUEUED, CLAIMED, PROCESSING), so a plan that finished a second ago cannot become the
target of a cancel meant for the deploy that is still running.

` + "`--dry-run`" + ` resolves the job and reports which one would be cancelled, without cancelling it.
Without a terminal the command needs ` + "`--yes`" + `; it never cancels unconfirmed.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		// Scoped, because this is the destructive one: an unscoped --latest would resolve to the
		// newest job of ANY status, which is either a refusal from the control plane or, under
		// --yes, a cancellation of a job the operator never meant to name.
		ref, err := resolveJobIn(apiClient, args, jobsCancelSelector, cancellableJobScope)
		if err != nil {
			fail(err)
		}
		p := printerFor(cmd)
		dryRun := cmdmeta.DryRunRequested(cmd)

		// A destructive command that resolved its own target must say what the target was. With
		// --yes there is no confirmation to carry it, so it is announced before the mutation. A
		// dry run asks nothing, so it announces too.
		if jobsCancelYes || dryRun {
			announceResolvedJob(ref, "Cancelling")
		}

		if !dryRun && !confirmDestructive(
			jobsCancelYes,
			fmt.Sprintf("Cancel job %s?", ref.ID),
			cancelJobWarning(ref),
		) {
			return
		}

		var result MutationResult
		runSpinner("Cancelling job...", func() {
			result, err = runJobCancel(apiClient, ref.ID, dryRun)
		})
		if err != nil {
			fail(err)
		}
		if err := p.Result(result, func(w io.Writer) {
			if result.DryRun {
				ui.MutedTo(w, fmt.Sprintf("Dry run: job %s would be cancelled. Nothing was changed.", ref.ID))
				return
			}
			ui.SuccessTo(w, fmt.Sprintf("Job %s cancelled", ref.ID))
		}); err != nil {
			fail(err)
		}
	},
}

// jobCanceller is the one call `jobs cancel` makes, so the command body runs against a fake.
type jobCanceller interface {
	CancelJob(jobID string) error
}

// runJobCancel cancels one job and returns the mutation result. With dryRun nothing is sent: the
// result names the job that would be cancelled and carries dry_run true.
func runJobCancel(client jobCanceller, jobID string, dryRun bool) (MutationResult, error) {
	result := MutationResult{ID: jobID, Kind: "job", Action: ResultUpdated, DryRun: dryRun}
	if dryRun {
		result.Action = ResultUnchanged
		return result, nil
	}
	if err := client.CancelJob(jobID); err != nil {
		return MutationResult{}, jobCancelError(err, jobID)
	}
	result.Object = map[string]string{"id": jobID, "status": jobStatusCancelled}
	return result, nil
}

// jobCancelError classifies a refused cancel and names the next step.
//
// The control plane answers a job that has already finished with a 400. That is not a malformed
// request — the same command was valid a moment earlier — so it is reported as the conflict it is
// (exit 7), not as a usage error.
func jobCancelError(err error, jobID string) error {
	e := *clierr.From(fmt.Errorf("failed to cancel job %s: %w", jobID, err))
	switch {
	case e.HTTPStatus == http.StatusBadRequest:
		e.Code = clierr.CodeConflict
		e.Class = clierr.ClassConflict
		e.Exit = clierr.ExitConflict
		e.Retryable = false
		e.Hint = "alethia jobs get " + jobID
	case e.Class == clierr.ClassConflict && e.Hint == "":
		e.Hint = "alethia jobs get " + jobID
	case e.Class == clierr.ClassNotFound && e.Hint == "":
		e.Hint = "alethia jobs list --status PROCESSING"
	}
	return &e
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
	// Registered here rather than left to the registry, which adds a generic --dry-run to any
	// command whose entry declares one and that has none: this wording says what the dry run of
	// THIS command reports, and the flag exists on the tree before the registry is applied.
	jobsCancelCmd.Flags().Bool(cmdmeta.DryRunFlag, false,
		"Resolve the job and report which one would be cancelled, without cancelling it")
	addJobSelectorFlags(jobsCancelCmd, &jobsCancelSelector)
	jobsCmd.AddCommand(jobsCancelCmd)
}
