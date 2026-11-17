// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// jobPollInterval is how often `--wait` polls a job's status. It is a variable so a
// test can shorten it; nothing in production assigns to it, so the interval is the
// same 3 seconds it always was.
var jobPollInterval = 3 * time.Second

// maxPollFailures is how many polls IN A ROW may fail with a retryable error before the wait gives
// up. A poll that succeeds resets the count, so a long wait survives any number of separate blips
// and stops only when the control plane has been unreachable for the whole run of them.
const maxPollFailures = 5

// The job statuses the wait loop ends on.
const (
	jobStatusSuccess   = "SUCCESS"
	jobStatusFailed    = "FAILED"
	jobStatusCancelled = "CANCELLED"
)

// jobPoller is the one call the wait loop makes. An interface rather than *api.Client so `alethia
// apply` can wait through the same loop under a fake control plane.
type jobPoller interface {
	GetJob(jobID string) (*api.ProvisionJob, error)
}

// waitOptions is how one wait behaves.
type waitOptions struct {
	// Timeout is the longest the wait may run. Zero means no deadline.
	Timeout time.Duration
	// JobType names the job in the error's operation until the first poll has answered with the
	// job's own type. Empty is fine.
	JobType string
	// Progress receives the narration, on its Err stream. Nil waits silently. The verdict is the
	// return value either way.
	Progress *Printer
}

// awaitJob polls a job until it is terminal and returns it, or returns a classified error.
//
// The four ways a wait ends without success each own a row of the exit table, so a script can tell
// them apart without reading a sentence:
//
//   - the job finished FAILED or CANCELLED — operation_failed, exit 13;
//   - opts.Timeout passed with the job still running — wait_timeout, exit 12. Nothing was
//     cancelled; the error's operation names the job and its hint is the command that resumes
//     watching it;
//   - ctx was cancelled — interrupted, exit 130;
//   - the control plane could not be asked — the class of the poll error itself. A retryable one
//     (the network, a server fault, a rate limit) is retried at the poll interval, up to
//     maxPollFailures in a row; any other ends the wait at once.
//
// The deadline is checked between polls. One poll in flight is bounded by the API client's own
// timeout, not by this one.
func awaitJob(ctx context.Context, poller jobPoller, jobID string, opts waitOptions) (*api.ProvisionJob, error) {
	if opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}
	say := func(format string, args ...any) {
		if opts.Progress != nil {
			fmt.Fprintf(opts.Progress.Err, format, args...)
		}
	}
	op := &clierr.Op{ID: jobID, Type: opts.JobType}

	say("\n%s Waiting for job %s...\n", ui.MutedStyle.Render(ui.SymbolPoint), jobID)

	lastStatus := ""
	failures := 0
	for {
		job, err := poller.GetJob(jobID)
		if err != nil {
			failures++
			if !clierr.From(err).Retryable || failures >= maxPollFailures {
				return nil, fmt.Errorf("failed to poll job status: %w", err)
			}
		} else {
			failures = 0
			if job.JobType != "" {
				op.Type = job.JobType
			}
			if job.Status != lastStatus {
				lastStatus = job.Status
				say("  Status: %s\n", ui.StatusVerbatim(job.Status))
			}
			if done, verdict := jobVerdict(job, op); done {
				if verdict == nil && opts.Progress != nil {
					ui.SuccessTo(opts.Progress.Err, "Job completed successfully")
					// Through jobCostSummary (jobs_get.go), the same renderer the job card uses.
					if c := jobCostSummary(job.ExecutionMetadata); c != "" {
						say("  Cost estimate: %s\n", c)
					}
				}
				return job, verdict
			}
		}

		if err := sleepOrDone(ctx, jobPollInterval); err != nil {
			return nil, waitEnded(err, op, opts.Timeout)
		}
	}
}

// jobVerdict reports whether a job is terminal and, when it is, the error its ending is: nil for a
// success, operation_failed for a failure or a cancellation.
func jobVerdict(job *api.ProvisionJob, op *clierr.Op) (bool, error) {
	var failed *clierr.Error
	switch job.Status {
	case jobStatusSuccess:
		return true, nil
	case jobStatusFailed:
		reason := "unknown error"
		if job.ErrorMessage != nil {
			reason = *job.ErrorMessage
		}
		failed = clierr.New(clierr.CodeOperationFailed, "job failed: "+reason)
	case jobStatusCancelled:
		failed = clierr.New(clierr.CodeOperationFailed, "job was cancelled")
	default:
		return false, nil
	}
	failed.Operation = op
	failed.Hint = "alethia jobs logs " + op.ID
	return true, failed
}

// sleepOrDone waits for d, or returns ctx's error as soon as ctx ends.
func sleepOrDone(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// waitEnded classifies a wait that stopped before its job did: a passed deadline is a wait
// timeout, and anything else that ends a context is an interrupt.
func waitEnded(cause error, op *clierr.Op, timeout time.Duration) error {
	var e *clierr.Error
	if errors.Is(cause, context.DeadlineExceeded) {
		e = clierr.New(clierr.CodeWaitTimeout,
			fmt.Sprintf("timed out after %s waiting for job %s; it is still running", timeout, op.ID))
		e.Hint = "alethia jobs logs " + op.ID + " --follow"
	} else {
		e = clierr.New(clierr.CodeInterrupted,
			fmt.Sprintf("interrupted while waiting for job %s; it is still running", op.ID))
	}
	e.Cause = cause
	e.Operation = op
	return e
}

// --- The --wait and --timeout flags ---

// waitFlags holds the two flags every long-running command takes.
type waitFlags struct {
	// Wait reports whether the command blocks until the job is terminal.
	Wait bool
	// Timeout bounds that wait. Zero means no deadline.
	Timeout time.Duration
}

// addWaitFlags registers --wait and --timeout on a long-running command, so every one of them
// spells the pair and its help text the same way. waitByDefault is the command's own default for
// --wait.
func addWaitFlags(cmd *cobra.Command, target *waitFlags, waitByDefault bool) {
	cmd.Flags().BoolVar(&target.Wait, "wait", waitByDefault, "Wait for the job to finish")
	cmd.Flags().DurationVar(&target.Timeout, "timeout", 0,
		"With --wait, stop waiting after this long, for example 30m (the job keeps running; exits 12). 0 waits without a limit")
}

// options returns the wait these flags describe, narrated through p.
func (f waitFlags) options(jobType string, p *Printer) waitOptions {
	return waitOptions{Timeout: f.Timeout, JobType: jobType, Progress: p}
}

// --- The spellings the commands still call ---

// waitForJob waits for a job with no deadline, narrating on stderr.
//
// It and waitForJobQuiet are awaitJob under the signatures the commands were written against. They
// add one thing awaitJob does not do: they PRINT a failed or cancelled job's line themselves,
// because their callers exit on the returned error without rendering it.
func waitForJob(apiClient jobPoller, jobID string) error {
	return waitForJobQuiet(apiClient, jobID, false)
}

// waitForJobQuiet is waitForJob with the narration suppressible, which is what a command printing a
// document on stdout used to need when the narration shared that stream. The verdict is the RETURN
// VALUE, so a quiet wait still fails the command.
func waitForJobQuiet(apiClient jobPoller, jobID string, quiet bool) error {
	opts := waitOptions{}
	if !quiet {
		opts.Progress = printer
	}
	_, err := awaitJob(context.Background(), apiClient, jobID, opts)
	if err == nil || quiet {
		return err
	}
	if e := clierr.From(err); e.Class == clierr.ClassOperationFailed {
		ui.ErrorTo(printer.Err, upperFirst(e.Message))
	}
	return err
}

// upperFirst returns s with its first byte upper-cased, for a message that opens a line of its own.
func upperFirst(s string) string {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return s
	}
	return string(s[0]-'a'+'A') + s[1:]
}
