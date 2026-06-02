package cmd

import (
	"fmt"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/charmbracelet/lipgloss"
)

var (
	successIcon = lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true).Render("✓")
	failIcon    = lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Bold(true).Render("✗")
	waitIcon    = lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Bold(true).Render("⏳")
)

func waitForJob(apiClient *api.Client, jobID string) error {
	fmt.Printf("\n%s Waiting for job %s...\n", waitIcon, jobID)

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
			fmt.Printf("\n%s Job completed successfully\n", successIcon)
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
			fmt.Printf("\n%s Job failed: %s\n", failIcon, errMsg)
			return fmt.Errorf("job failed: %s", errMsg)
		case "CANCELLED":
			fmt.Printf("\n%s Job was cancelled\n", failIcon)
			return fmt.Errorf("job was cancelled")
		}

		time.Sleep(3 * time.Second)
	}
}

func formatJobStatus(status string) string {
	switch status {
	case "QUEUED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Render("QUEUED")
	case "CLAIMED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("214")).Render("CLAIMED")
	case "PROCESSING":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("39")).Render("PROCESSING")
	case "SUCCESS":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Render("SUCCESS")
	case "FAILED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Render("FAILED")
	case "CANCELLED":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render("CANCELLED")
	default:
		return status
	}
}
