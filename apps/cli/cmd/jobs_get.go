// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var jobsGetCmd = &cobra.Command{
	Use:   "get <job_id>",
	Short: "Get details of a specific job",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		jobID := args[0]

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		var job *api.ProvisionJob

		spinner.New().
			Title("Fetching job details...").
			Action(func() {
				job, err = apiClient.GetJob(jobID)
			}).Run()

		if err != nil {
			failf("Failed to fetch job: %v", err)
		}

		printJob(job)
	},
}

func printJob(job *api.ProvisionJob) {
	doc := strings.Builder{}

	kv := func(key, value string) {
		doc.WriteString(ui.KeyStyle.Render(key))
		doc.WriteString(ui.ValueStyle.Render(value))
		doc.WriteString("\n")
	}

	doc.WriteString(ui.AccentStyle.Render("  Job Details"))
	doc.WriteString("\n\n")
	kv("ID:", job.ID)
	kv("Type:", job.JobType)
	kv("Status:", job.Status)
	kv("Created:", job.CreatedAt.Format("2006-01-02 15:04:05"))

	if job.StartedAt != nil {
		kv("Started:", job.StartedAt.Format("2006-01-02 15:04:05"))
	}
	if job.CompletedAt != nil {
		kv("Completed:", job.CompletedAt.Format("2006-01-02 15:04:05"))
	}
	if job.ProjectID != "" {
		kv("Project ID:", job.ProjectID)
	}
	if job.RunnerID != "" {
		kv("Runner ID:", job.RunnerID)
	}
	if job.PlanJobID != "" {
		kv("Plan Job ID:", job.PlanJobID)
	}
	if job.ErrorMessage != nil && *job.ErrorMessage != "" {
		doc.WriteString(ui.KeyStyle.Render("Error:"))
		doc.WriteString(ui.ErrorStyle.Render(*job.ErrorMessage))
		doc.WriteString("\n")
	}

	fmt.Println(doc.String())
}

func init() {
	jobsCmd.AddCommand(jobsGetCmd)
}
