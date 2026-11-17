// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// pollStep is one answer of the scripted control plane.
type pollStep struct {
	job *api.ProvisionJob
	err error
}

// scriptedPoller answers GetJob from a script, repeating the last step once the script runs out, and
// counts the polls it served.
type scriptedPoller struct {
	steps []pollStep
	calls int
}

// GetJob returns the next scripted answer.
func (s *scriptedPoller) GetJob(string) (*api.ProvisionJob, error) {
	i := s.calls
	if i >= len(s.steps) {
		i = len(s.steps) - 1
	}
	s.calls++
	return s.steps[i].job, s.steps[i].err
}

// waitJob builds a job in one status.
func waitJob(status string) *api.ProvisionJob {
	return &api.ProvisionJob{ID: "job_1", JobType: "DEPLOY", Status: status}
}

// fastPolls shortens the poll interval for one test.
func fastPolls(t *testing.T) {
	t.Helper()
	prev := jobPollInterval
	jobPollInterval = time.Millisecond
	t.Cleanup(func() { jobPollInterval = prev })
}

// unavailable is a poll error the wait may retry; forbidden is one it may not.
var (
	errPollUnavailable = &api.APIError{StatusCode: http.StatusServiceUnavailable, Message: "upstream is restarting"}
	errPollForbidden   = &api.APIError{StatusCode: http.StatusForbidden, Message: "not a member"}
)

// TestAwaitJob_SuccessNarratesOnErrAndReturnsTheJob is the ordinary path.
func TestAwaitJob_SuccessNarratesOnErrAndReturnsTheJob(t *testing.T) {
	fastPolls(t)
	done := waitJob(jobStatusSuccess)
	meta := map[string]interface{}{"cost_breakdown": "about $12/mo"}
	done.ExecutionMetadata = &meta
	poller := &scriptedPoller{steps: []pollStep{
		{job: waitJob("QUEUED")}, {job: waitJob("RUNNING")}, {job: waitJob("RUNNING")}, {job: done},
	}}
	p, out, errOut := newTestPrinter(ui.FormatJSON, Mode{})

	job, err := awaitJob(context.Background(), poller, "job_1", waitOptions{Progress: p})
	if err != nil {
		t.Fatalf("awaitJob: %v", err)
	}
	if job != done {
		t.Errorf("returned %+v, want the terminal job", job)
	}
	if out.Len() != 0 {
		t.Errorf("the narration reached Out: %q", out.String())
	}
	got := errOut.String()
	for _, want := range []string{"Waiting for job job_1...", "QUEUED", "RUNNING", "SUCCESS", "Job completed successfully"} {
		if !strings.Contains(got, want) {
			t.Errorf("Err is missing %q:\n%s", want, got)
		}
	}
	if n := strings.Count(got, "RUNNING"); n != 1 {
		t.Errorf("an unchanged status was announced %d times, want once:\n%s", n, got)
	}
	if c := jobCostSummary(done.ExecutionMetadata); c == "" || !strings.Contains(got, "Cost estimate: "+c) {
		t.Errorf("the cost line is missing (summary %q):\n%s", c, got)
	}
}

// TestAwaitJob_SilentWithoutAPrinter: the verdict is the return value.
func TestAwaitJob_SilentWithoutAPrinter(t *testing.T) {
	fastPolls(t)
	read := modeStderr(t)
	poller := &scriptedPoller{steps: []pollStep{{job: waitJob("RUNNING")}, {job: waitJob(jobStatusSuccess)}}}
	if _, err := awaitJob(context.Background(), poller, "job_1", waitOptions{}); err != nil {
		t.Fatalf("awaitJob: %v", err)
	}
	if got := read(); got != "" {
		t.Errorf("a wait with no Printer wrote %q", got)
	}
}

// TestAwaitJob_AFinishedFailureIsExit13 covers FAILED, with and without a reason, and CANCELLED.
func TestAwaitJob_AFinishedFailureIsExit13(t *testing.T) {
	fastPolls(t)
	reason := "tofu apply exited 1"
	withReason := waitJob(jobStatusFailed)
	withReason.ErrorMessage = &reason

	cases := []struct {
		name    string
		job     *api.ProvisionJob
		message string
	}{
		{"failed with a reason", withReason, "job failed: tofu apply exited 1"},
		{"failed without one", waitJob(jobStatusFailed), "job failed: unknown error"},
		{"cancelled", waitJob(jobStatusCancelled), "job was cancelled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			poller := &scriptedPoller{steps: []pollStep{{job: waitJob("RUNNING")}, {job: tc.job}}}
			p, _, errOut := newTestPrinter(ui.FormatTable, Mode{})
			job, err := awaitJob(context.Background(), poller, "job_1", waitOptions{Progress: p})
			if job != tc.job {
				t.Errorf("the terminal job was not returned beside its error")
			}
			e := clierr.From(err)
			if err == nil || e.Exit != clierr.ExitOperationFailed || e.Code != clierr.CodeOperationFailed {
				t.Fatalf("got %v, want operation_failed / exit %d", err, clierr.ExitOperationFailed)
			}
			if e.Message != tc.message {
				t.Errorf("message = %q, want %q", e.Message, tc.message)
			}
			if e.Operation == nil || e.Operation.ID != "job_1" || e.Operation.Type != "DEPLOY" {
				t.Errorf("operation = %+v, want job_1 / DEPLOY", e.Operation)
			}
			if e.Hint != "alethia jobs logs job_1" {
				t.Errorf("hint = %q", e.Hint)
			}
			// awaitJob returns the failure; it does not also print it. Whoever renders the error
			// prints it once.
			if strings.Contains(errOut.String(), "ob failed") || strings.Contains(errOut.String(), "cancelled") {
				t.Errorf("awaitJob printed the failure itself:\n%s", errOut.String())
			}
		})
	}
}

// TestAwaitJob_ADeadlineIsExit12AndNamesTheJob: the job is still running, and the error says how to
// pick it up again.
func TestAwaitJob_ADeadlineIsExit12AndNamesTheJob(t *testing.T) {
	fastPolls(t)
	poller := &scriptedPoller{steps: []pollStep{{job: waitJob("RUNNING")}}}

	_, err := awaitJob(context.Background(), poller, "job_1", waitOptions{Timeout: 20 * time.Millisecond, JobType: "PLAN"})
	e := clierr.From(err)
	if err == nil || e.Exit != clierr.ExitWaitTimeout || e.Code != clierr.CodeWaitTimeout {
		t.Fatalf("got %v, want wait_timeout / exit %d", err, clierr.ExitWaitTimeout)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("the deadline is not reachable through the error chain: %v", err)
	}
	if e.Operation == nil || e.Operation.ID != "job_1" {
		t.Errorf("operation = %+v, want job_1", e.Operation)
	}
	// The job answered with its own type, which wins over the caller's guess.
	if e.Operation != nil && e.Operation.Type != "DEPLOY" {
		t.Errorf("operation type = %q, want the polled job's DEPLOY", e.Operation.Type)
	}
	if e.Hint != "alethia jobs logs job_1 --follow" {
		t.Errorf("hint = %q, want the command that resumes the watch", e.Hint)
	}
	if !strings.Contains(e.Message, "20ms") || !strings.Contains(e.Message, "still running") {
		t.Errorf("message = %q", e.Message)
	}
	if poller.calls < 2 {
		t.Errorf("the wait polled %d time(s) before its deadline; it should have kept polling", poller.calls)
	}
}

// TestAwaitJob_TheCallersTypeNamesAJobThatNeverAnswered: with no successful poll, the operation
// carries the type the caller passed.
func TestAwaitJob_TheCallersTypeNamesAJobThatNeverAnswered(t *testing.T) {
	fastPolls(t)
	poller := &scriptedPoller{steps: []pollStep{{job: &api.ProvisionJob{ID: "job_1", Status: "QUEUED"}}}}
	_, err := awaitJob(context.Background(), poller, "job_1", waitOptions{Timeout: 5 * time.Millisecond, JobType: "PLAN"})
	if e := clierr.From(err); e.Operation == nil || e.Operation.Type != "PLAN" {
		t.Errorf("operation = %+v, want type PLAN", e.Operation)
	}
}

// TestAwaitJob_ACancelledContextIsAnInterrupt is the other way a context ends.
func TestAwaitJob_ACancelledContextIsAnInterrupt(t *testing.T) {
	fastPolls(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	poller := &scriptedPoller{steps: []pollStep{{job: waitJob("RUNNING")}}}

	_, err := awaitJob(ctx, poller, "job_1", waitOptions{Timeout: time.Hour})
	e := clierr.From(err)
	if err == nil || e.Exit != clierr.ExitInterrupted || e.Code != clierr.CodeInterrupted {
		t.Fatalf("got %v, want interrupted / exit %d", err, clierr.ExitInterrupted)
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("the cancellation is not reachable through the error chain: %v", err)
	}
	if e.Operation == nil || e.Operation.ID != "job_1" {
		t.Errorf("operation = %+v", e.Operation)
	}
}

// TestAwaitJob_TransientPollErrorsAreRetried: a blip is survived, the count resets on a good poll,
// and an unbroken run of them ends the wait with the poll error's own class.
func TestAwaitJob_TransientPollErrorsAreRetried(t *testing.T) {
	fastPolls(t)

	blips := make([]pollStep, 0, 2*maxPollFailures)
	for i := 0; i < maxPollFailures-1; i++ {
		blips = append(blips, pollStep{err: errPollUnavailable})
	}
	blips = append(blips, pollStep{job: waitJob("RUNNING")})
	for i := 0; i < maxPollFailures-1; i++ {
		blips = append(blips, pollStep{err: errPollUnavailable})
	}
	blips = append(blips, pollStep{job: waitJob(jobStatusSuccess)})
	poller := &scriptedPoller{steps: blips}
	if _, err := awaitJob(context.Background(), poller, "job_1", waitOptions{}); err != nil {
		t.Fatalf("two runs of %d blips with a good poll between them ended the wait: %v", maxPollFailures-1, err)
	}
	if poller.calls != len(blips) {
		t.Errorf("polled %d times, want %d", poller.calls, len(blips))
	}

	poller = &scriptedPoller{steps: []pollStep{{err: errPollUnavailable}}}
	_, err := awaitJob(context.Background(), poller, "job_1", waitOptions{})
	e := clierr.From(err)
	if err == nil || e.Exit != clierr.ExitUnavailable {
		t.Fatalf("an unreachable control plane: got %v, want exit %d", err, clierr.ExitUnavailable)
	}
	if poller.calls != maxPollFailures {
		t.Errorf("gave up after %d polls, want %d", poller.calls, maxPollFailures)
	}
	if !strings.HasPrefix(e.Message, "failed to poll job status: ") {
		t.Errorf("message = %q", e.Message)
	}
}

// TestAwaitJob_APermanentPollErrorEndsTheWaitAtOnce: no retry can turn a refusal into an answer.
func TestAwaitJob_APermanentPollErrorEndsTheWaitAtOnce(t *testing.T) {
	fastPolls(t)
	poller := &scriptedPoller{steps: []pollStep{{err: errPollForbidden}}}
	_, err := awaitJob(context.Background(), poller, "job_1", waitOptions{})
	if e := clierr.From(err); err == nil || e.Exit != clierr.ExitForbidden {
		t.Fatalf("got %v, want exit %d", err, clierr.ExitForbidden)
	}
	if poller.calls != 1 {
		t.Errorf("a permanent error was polled %d times, want 1", poller.calls)
	}
}

// TestWaitForJob_TheLegacySpellings covers the two wrappers the commands call: they narrate through
// the process Printer, print a finished failure themselves, and stay silent when asked to.
func TestWaitForJob_TheLegacySpellings(t *testing.T) {
	fastPolls(t)
	modeState(t)
	reason := "quota exceeded"
	failed := waitJob(jobStatusFailed)
	failed.ErrorMessage = &reason

	p, out, errOut := newTestPrinter(ui.FormatTable, Mode{})
	printer = p
	err := waitForJob(&scriptedPoller{steps: []pollStep{{job: failed}}}, "job_1")
	if clierr.From(err).Exit != clierr.ExitOperationFailed {
		t.Fatalf("waitForJob: %v", err)
	}
	if !strings.Contains(errOut.String(), "Job failed: quota exceeded") {
		t.Errorf("the failure line is missing from Err:\n%s", errOut.String())
	}
	if out.Len() != 0 {
		t.Errorf("the wait wrote to Out: %q", out.String())
	}

	p, _, errOut = newTestPrinter(ui.FormatTable, Mode{})
	printer = p
	if err := waitForJob(&scriptedPoller{steps: []pollStep{{job: waitJob(jobStatusCancelled)}}}, "job_1"); err == nil {
		t.Fatal("a cancelled job returned nil")
	}
	if !strings.Contains(errOut.String(), "Job was cancelled") {
		t.Errorf("the cancellation line is missing from Err:\n%s", errOut.String())
	}

	p, _, errOut = newTestPrinter(ui.FormatTable, Mode{})
	printer = p
	if err := waitForJob(&scriptedPoller{steps: []pollStep{{job: waitJob(jobStatusSuccess)}}}, "job_1"); err != nil {
		t.Fatalf("a successful job: %v", err)
	}
	if !strings.Contains(errOut.String(), "Job completed successfully") {
		t.Errorf("the success line is missing from Err:\n%s", errOut.String())
	}

	// A poll error is not a finished job, so the wrapper adds no line of its own for it.
	p, _, errOut = newTestPrinter(ui.FormatTable, Mode{})
	printer = p
	if err := waitForJob(&scriptedPoller{steps: []pollStep{{err: errPollForbidden}}}, "job_1"); err == nil {
		t.Fatal("a refused poll returned nil")
	}
	if strings.Contains(errOut.String(), ui.SymbolError) {
		t.Errorf("the wrapper printed a failure line for a poll error:\n%s", errOut.String())
	}

	p, out, errOut = newTestPrinter(ui.FormatJSON, Mode{})
	printer = p
	err = waitForJobQuiet(&scriptedPoller{steps: []pollStep{{job: failed}}}, "job_1", true)
	if clierr.From(err).Exit != clierr.ExitOperationFailed {
		t.Fatalf("a quiet wait lost its verdict: %v", err)
	}
	if out.Len() != 0 || errOut.Len() != 0 {
		t.Errorf("a quiet wait wrote out=%q err=%q", out.String(), errOut.String())
	}
}

// TestUpperFirst covers the three shapes of input.
func TestUpperFirst(t *testing.T) {
	for in, want := range map[string]string{"job failed": "Job failed", "": "", "Job": "Job", "9 lives": "9 lives"} {
		if got := upperFirst(in); got != want {
			t.Errorf("upperFirst(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestWaitFlags_OneSpellingForEveryLongRunningCommand pins the pair a command registers.
func TestWaitFlags_OneSpellingForEveryLongRunningCommand(t *testing.T) {
	for _, waitByDefault := range []bool{true, false} {
		var f waitFlags
		c := &cobra.Command{Use: "deploy"}
		addWaitFlags(c, &f, waitByDefault)
		if f.Wait != waitByDefault {
			t.Errorf("--wait defaults to %v, want %v", f.Wait, waitByDefault)
		}
		if c.Flags().Lookup("wait") == nil || c.Flags().Lookup("timeout") == nil {
			t.Fatal("--wait and --timeout are not both registered")
		}
	}

	var f waitFlags
	c := &cobra.Command{Use: "deploy"}
	addWaitFlags(c, &f, false)
	if err := c.ParseFlags([]string{"--wait", "--timeout", "90s"}); err != nil {
		t.Fatal(err)
	}
	p, _, _ := newTestPrinter(ui.FormatTable, Mode{})
	opts := f.options("DEPLOY", p)
	if !f.Wait || opts.Timeout != 90*time.Second || opts.JobType != "DEPLOY" || opts.Progress != p {
		t.Errorf("flags = %+v, options = %+v", f, opts)
	}
	if err := c.ParseFlags([]string{"--timeout", "soon"}); err == nil {
		t.Error("--timeout accepted a value that is not a duration")
	}
}
