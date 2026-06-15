// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/api"
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
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)
		stderrStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
		systemStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Italic(true)

		lastID := 0
		for {
			logs, err := apiClient.GetJobLogs(jobID, lastID)
			if err != nil {
				fmt.Printf("Error fetching logs: %v\n", err)
				os.Exit(1)
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
