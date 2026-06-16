// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func waitForJob(apiClient *api.Client, jobID string) error {
	fmt.Printf("\n%s Waiting for job %s...\n", ui.WarningStyle.Render(ui.SymbolWaiting), jobID)

	lastStatus := ""
	for {
		job, err := apiClient.GetJob(jobID)
		if err != nil {
			return fmt.Errorf("failed to poll job status: %w", err)
		}

		if job.Status != lastStatus {
			lastStatus = job.Status
			fmt.Printf("  Status: %s\n", formatJobStatus(job.Status))
		}

		switch job.Status {
		case "SUCCESS":
			ui.Success("Job completed successfully")
			if job.ExecutionMetadata != nil {
				if costBreakdown, ok := (*job.ExecutionMetadata)["cost_breakdown"]; ok {
					fmt.Printf("  Cost estimate: %v\n", costBreakdown)
				}
			}
			return nil
		case "FAILED":
			errMsg := "unknown error"
			if job.ErrorMessage != nil {
				errMsg = *job.ErrorMessage
			}
			ui.Error(fmt.Sprintf("Job failed: %s", errMsg))
			return fmt.Errorf("job failed: %s", errMsg)
		case "CANCELLED":
			ui.Error("Job was cancelled")
			return fmt.Errorf("job was cancelled")
		}

		time.Sleep(3 * time.Second)
	}
}

func formatJobStatus(status string) string {
	switch status {
	case "QUEUED", "CLAIMED":
		return ui.WarningStyle.Render(status)
	case "PROCESSING":
		return ui.CyanStyle.Render(status)
	case "SUCCESS":
		return ui.SuccessStyle.Render(status)
	case "FAILED":
		return ui.ErrorStyle.Render(status)
	case "CANCELLED":
		return ui.MutedStyle.Render(status)
	default:
		return status
	}
}
