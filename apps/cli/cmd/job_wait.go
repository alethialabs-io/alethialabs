// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// jobPollInterval is how often `--wait` polls a job's status. It is a variable so a
// test can shorten it; nothing in production assigns to it, so the interval is the
// same 3 seconds it always was.
var jobPollInterval = 3 * time.Second

// jobPoller is the one call waitForJob makes. An interface rather than *api.Client so `alethia
// apply` can wait through the same loop under a fake control plane.
type jobPoller interface {
	GetJob(jobID string) (*api.ProvisionJob, error)
}

// waitForJob polls until the job is terminal, reporting progress on the HUMAN output only.
//
// `quiet` is what `--output json` passes. Every line below used to go to stdout unconditionally,
// so `alethia apply --yes --output json | jq .` failed on the first byte — the waiting line, each
// status transition, the success line and the cost estimate all landed in the document, once per
// waited environment. `executeApply` gates its own progress and this loop did not, which is the
// shape a `--output` split has to be applied at every writer or at none.
func waitForJob(apiClient jobPoller, jobID string) error {
	return waitForJobQuiet(apiClient, jobID, false)
}

// waitForJobQuiet is waitForJob with the progress suppressible. The verdict is the RETURN VALUE,
// so a quiet wait still fails the command; only the narration is withheld.
func waitForJobQuiet(apiClient jobPoller, jobID string, quiet bool) error {
	say := func(format string, args ...any) {
		if !quiet {
			fmt.Printf(format, args...)
		}
	}
	say("\n%s Waiting for job %s...\n", ui.MutedStyle.Render(ui.SymbolPoint), jobID)

	lastStatus := ""
	for {
		job, err := apiClient.GetJob(jobID)
		if err != nil {
			return fmt.Errorf("failed to poll job status: %w", err)
		}

		if job.Status != lastStatus {
			lastStatus = job.Status
			say("  Status: %s\n", ui.StatusVerbatim(job.Status))
		}

		switch job.Status {
		case "SUCCESS":
			if !quiet {
				ui.Success("Job completed successfully")
			}
			// Through jobCostSummary (jobs_get.go), the same renderer the job card uses. This line
			// used to be `fmt.Printf("  Cost estimate: %v\n", costBreakdown)` over the decoded
			// `any`, so the last thing a successful `project apply --wait` said was a Go map
			// literal several hundred characters long.
			if c := jobCostSummary(job.ExecutionMetadata); c != "" {
				say("  Cost estimate: %s\n", c)
			}
			return nil
		case "FAILED":
			errMsg := "unknown error"
			if job.ErrorMessage != nil {
				errMsg = *job.ErrorMessage
			}
			if !quiet {
				ui.Error(fmt.Sprintf("Job failed: %s", errMsg))
			}
			return fmt.Errorf("job failed: %s", errMsg)
		case "CANCELLED":
			if !quiet {
				ui.Error("Job was cancelled")
			}
			return fmt.Errorf("job was cancelled")
		}

		time.Sleep(jobPollInterval)
	}
}

// formatJobStatus is DELETED. It was the third status renderer — a switch over five job statuses
// that returned the status TEXT in one of five lipgloss styles and drew no glyph at all. Three of
// those styles (SuccessStyle, ErrorStyle, CyanStyle) are the same bold strong ink in a grayscale
// palette, so `job wait` printed SUCCESS and FAILED identically and `jobs logs --follow` closed
// with a line that said nothing a reader could act on. ui.Status renders the glyph and the word
// in the tier's ink, over the generated vocabulary, and every command says it the same way.
