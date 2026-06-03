package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/utils/ui"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
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
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)
		var job *api.ProvisionJob

		spinner.New().
			Title("Fetching job details...").
			Action(func() {
				job, err = apiClient.GetJob(jobID)
			}).Run()

		if err != nil {
			ui.Error(fmt.Sprintf("Failed to fetch job: %v", err))
			os.Exit(1)
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
	if job.VineyardID != "" {
		kv("Vineyard ID:", job.VineyardID)
	}
	if job.ConfigurationID != "" {
		kv("Vine ID:", job.ConfigurationID)
	}
	if job.WorkerID != "" {
		kv("Tendril ID:", job.WorkerID)
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
