// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	jobsLogsFollow   bool
	jobsLogsTimeout  time.Duration
	jobsLogsSelector jobSelector
)

// jobsLogsPollInterval is how long `--follow` waits between log fetches. It is a
// variable so a test can shorten it; nothing in production assigns to it, so the
// interval is the same 2 seconds it always was.
var jobsLogsPollInterval = 2 * time.Second

// The two log-stream renderings, from the shared styles rather than a lipgloss style built here.
// Byte-identical to what they replaced — ui.StrongStyle IS InkPrimary + bold — but they now move
// with the brand projection instead of pinning a copy of it in this file.
var (
	jobLogStderrStyle = ui.StrongStyle
	jobLogSystemStyle = ui.MutedStyle.Italic(true)
)

var jobsLogsCmd = &cobra.Command{
	Use:   "logs [job_id]",
	Short: "Print a job's log, or follow it until the job ends",
	Long: `Print a job's Runner output — the tofu plan/apply, the resource progress, the errors.

Without ` + "`--follow`" + ` it prints what has been written so far and exits 0, whatever state the job
is in. With ` + "`--follow`" + ` it keeps printing until the job ends, and then the exit status is the
job's: 0 when it succeeded, 13 when it failed or was cancelled. ` + "`--timeout`" + ` bounds the follow and
exits 12 with the job still running; Ctrl-C exits 130. A fetch that fails for a passing reason — the
network, a server fault — is retried, so one bad poll does not end a long follow.

The log is on stdout and nothing else is: the closing status line, a deploy's warnings and every
note are on stderr. Under ` + "`-o json`" + ` the command prints one object with the job id, the log chunks
and, when followed, the final status.

The id is optional. ` + "`alethia jobs logs --latest --follow`" + ` tails the job you just queued
without copying its id out of the previous command; on a terminal, running it bare opens a picker.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		opts := jobLogsOptions{Follow: jobsLogsFollow, Timeout: jobsLogsTimeout}
		// Checked before anything is asked or fetched: it is a statement about the command line.
		if err := opts.validate(); err != nil {
			fail(err)
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		ref, err := resolveJob(apiClient, args, jobsLogsSelector)
		if err != nil {
			fail(err)
		}
		p := printerFor(cmd)
		// The CLI chose this job, so it says which one before the output starts. Otherwise a
		// `--latest` tail is a wall of tofu output with nothing identifying whose it is.
		announceResolvedJob(ref, "Tailing")

		// Ctrl-C ends the follow through the context, so it is reported as an interrupt with the
		// job id rather than killing the process mid-line.
		ctx, stop := signal.NotifyContext(commandContext(cmd), os.Interrupt)
		defer stop()
		if err := runJobLogs(ctx, apiClient, p, ref.ID, opts); err != nil {
			fail(err)
		}
	},
}

// commandContext is cmd's context, or a background one for a command run outside Execute — which
// is the only case cobra leaves it nil.
func commandContext(cmd *cobra.Command) context.Context {
	if ctx := cmd.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}

// jobLogSource is the two calls the log reader makes, so it runs against a fake.
type jobLogSource interface {
	GetJobLogs(jobID string, afterID int) ([]api.JobLog, error)
	GetJob(jobID string) (*api.ProvisionJob, error)
}

// jobLogsOptions is how one read of a job's log behaves.
type jobLogsOptions struct {
	// Follow keeps reading until the job is terminal.
	Follow bool
	// Timeout bounds a follow. Zero means no deadline.
	Timeout time.Duration
}

// validate refuses a --timeout that has nothing to bound.
func (o jobLogsOptions) validate() error {
	if o.Timeout < 0 {
		return clierr.New(clierr.CodeInvalidFlag, "--timeout cannot be negative")
	}
	if o.Timeout > 0 && !o.Follow {
		return clierr.New(clierr.CodeInvalidFlag,
			"--timeout bounds a follow, and --follow was not given: add --follow, or drop --timeout")
	}
	return nil
}

// jobLogsResult is the `-o json` form of a job's log.
//
// Status is the job's final status and is present only after a follow, which is the only read that
// asks for it; a plain read reports what was written and makes no claim about the job's state.
type jobLogsResult struct {
	JobID  string       `json:"job_id"`
	Status string       `json:"status,omitempty"`
	Logs   []api.JobLog `json:"logs"`
}

// runJobLogs reads a job's log and writes it through p: the chunks as they arrive for a person, or
// one jobLogsResult under json.
//
// A plain read returns nil once the chunks are written. A follow returns the job's own verdict when
// it ends — nil for a success, operation_failed (exit 13) for a failure or a cancellation — so the
// command every queued job points at answers "did it work" with its exit status. It returns
// wait_timeout (exit 12) when opts.Timeout passes and interrupted (exit 130) when ctx is cancelled;
// in both the job is still running and the error names it.
//
// During a follow, a fetch that fails with a retryable error is tried again at the next poll, up
// to maxPollFailures in a row — the same rule awaitJob holds. Any other error, and any error on a
// plain read, ends the command with that error's own class.
func runJobLogs(ctx context.Context, src jobLogSource, p *Printer, jobID string, opts jobLogsOptions) error {
	if p.Format == ui.FormatCSV {
		return errNoCSVForm
	}
	if opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}
	collect := p.Format == ui.FormatJSON
	result := jobLogsResult{JobID: jobID, Logs: []api.JobLog{}}
	op := &clierr.Op{ID: jobID}

	lastID := 0
	// read fetches the chunks after lastID and either prints them or keeps them for the document.
	read := func() error {
		logs, err := src.GetJobLogs(jobID, lastID)
		if err != nil {
			return err
		}
		if collect {
			result.Logs = append(result.Logs, logs...)
			lastID = writeJobLogs(io.Discard, logs, lastID)
			return nil
		}
		lastID = writeJobLogs(p.Out, logs, lastID)
		return nil
	}

	failures := 0
	for {
		err := read()
		var job *api.ProvisionJob
		if err == nil && opts.Follow {
			job, err = src.GetJob(jobID)
		}
		switch {
		case err != nil:
			failures++
			if !opts.Follow || !clierr.From(err).Retryable || failures >= maxPollFailures {
				return jobLogsError(err, jobID)
			}
		case !opts.Follow:
			if collect {
				return p.Result(result, nil)
			}
			return nil
		default:
			failures = 0
			if job.JobType != "" {
				op.Type = job.JobType
			}
			if done, verdict := jobVerdict(job, op); done {
				return finishJobLogs(p, job, &result, read, verdict)
			}
		}

		if err := sleepOrDone(ctx, jobsLogsPollInterval); err != nil {
			return waitEnded(err, op, opts.Timeout)
		}
	}
}

// finishJobLogs closes a follow whose job has ended: the last chunks, the closing line or the
// document, the deploy's warnings, and the verdict as the return value.
func finishJobLogs(p *Printer, job *api.ProvisionJob, result *jobLogsResult, read func() error, verdict error) error {
	// One last drain: the status flipped between the last fetch and this poll, so the final
	// chunks may already be written and would otherwise be lost. A failure here loses only
	// those lines, and the verdict is still known, so it is said and not returned.
	if err := read(); err != nil {
		p.Warn(fmt.Sprintf("The job ended, but its last log lines could not be read (%v). Run `alethia jobs logs %s` for the whole log.", err, job.ID))
	}
	result.Status = job.Status
	if p.Format == ui.FormatJSON {
		if err := p.Result(*result, nil); err != nil {
			return err
		}
	} else {
		fmt.Fprintf(p.Err, "\n--- Job %s ---\n", ui.StatusVerbatim(job.Status))
		writeJobWarnings(p, jobWarnings(job))
	}
	if e := clierr.From(verdict); e != nil {
		// jobVerdict's hint is this command; from inside it, the next step is the job's record.
		failed := *e
		failed.Hint = "alethia jobs get " + job.ID
		return &failed
	}
	return nil
}

// jobLogsError classifies a failed log read and names the next step for a job that is not there.
func jobLogsError(err error, jobID string) error {
	e := *clierr.From(fmt.Errorf("failed to fetch logs for job %s: %w", jobID, err))
	if e.Class == clierr.ClassNotFound && e.Hint == "" {
		e.Hint = "alethia jobs list"
	}
	return &e
}

// writeJobLogs prints one batch of chunks and returns the highest log id seen, so the next
// fetch resumes after it.
//
// It exists because the loop above used to carry two byte-identical copies of this switch — the
// polling one and the final drain — and a change to how STDERR renders had to be made twice or
// the two halves of one stream would disagree.
func writeJobLogs(w io.Writer, logs []api.JobLog, lastID int) int {
	for _, log := range logs {
		switch log.StreamType {
		case "STDERR":
			fmt.Fprint(w, jobLogStderrStyle.Render(log.LogChunk))
		case "SYSTEM":
			fmt.Fprint(w, jobLogSystemStyle.Render(log.LogChunk))
		default:
			fmt.Fprint(w, log.LogChunk)
		}
		if log.ID > lastID {
			lastID = log.ID
		}
	}
	return lastID
}

func init() {
	jobsCmd.AddCommand(jobsLogsCmd)
	jobsLogsCmd.Flags().BoolVarP(&jobsLogsFollow, "follow", "f", false,
		"Keep printing until the job ends, then exit with its result (13 when it failed or was cancelled)")
	jobsLogsCmd.Flags().DurationVar(&jobsLogsTimeout, "timeout", 0,
		"With --follow, stop after this long, for example 30m (the job keeps running; exits 12). 0 follows without a limit")
	addJobSelectorFlags(jobsLogsCmd, &jobsLogsSelector)
}
