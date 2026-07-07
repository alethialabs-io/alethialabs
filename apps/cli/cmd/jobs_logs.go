// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

var jobsLogsFollow bool

var jobsLogsCmd = &cobra.Command{
	Use:   "logs <job_id>",
	Short: "View logs for a job",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		jobID := args[0]

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		stderrStyle := lipgloss.NewStyle().Foreground(ui.InkPrimary).Bold(true)
		systemStyle := lipgloss.NewStyle().Foreground(ui.InkMuted).Italic(true)

		lastID := 0
		for {
			logs, err := apiClient.GetJobLogs(jobID, lastID)
			if err != nil {
				failf("Error fetching logs: %v", err)
			}

			for _, log := range logs {
				switch log.StreamType {
				case "STDERR":
					fmt.Print(stderrStyle.Render(log.LogChunk))
				case "SYSTEM":
					fmt.Print(systemStyle.Render(log.LogChunk))
				default:
					fmt.Print(log.LogChunk)
				}
				if log.ID > lastID {
					lastID = log.ID
				}
			}

			if !jobsLogsFollow {
				break
			}

			job, err := apiClient.GetJob(jobID)
			if err == nil {
				switch job.Status {
				case "SUCCESS", "FAILED", "CANCELLED":
					logs, _ := apiClient.GetJobLogs(jobID, lastID)
					for _, log := range logs {
						switch log.StreamType {
						case "STDERR":
							fmt.Print(stderrStyle.Render(log.LogChunk))
						case "SYSTEM":
							fmt.Print(systemStyle.Render(log.LogChunk))
						default:
							fmt.Print(log.LogChunk)
						}
					}
					fmt.Printf("\n--- Job %s ---\n", formatJobStatus(job.Status))
					return
				}
			}

			time.Sleep(2 * time.Second)
		}
	},
}

func init() {
	jobsCmd.AddCommand(jobsLogsCmd)
	jobsLogsCmd.Flags().BoolVarP(&jobsLogsFollow, "follow", "f", false, "Keep polling for new logs")
}
