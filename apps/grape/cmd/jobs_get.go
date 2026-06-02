package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/charmbracelet/huh/spinner"
	"github.com/charmbracelet/lipgloss"
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
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		printJob(job)
	},
}

func printJob(job *api.ProvisionJob) {
	doc := strings.Builder{}

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("63")).Padding(1, 0)
	keyStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("244")).Padding(0, 2, 0, 2)
	valueStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("255"))

	kv := func(key, value string) {
		doc.WriteString(keyStyle.Render(key))
		doc.WriteString(valueStyle.Render(value))
		doc.WriteString("\n")
	}

	doc.WriteString(headerStyle.Render("Job Details"))
	doc.WriteString("\n")
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
		kv("Worker ID:", job.WorkerID)
	}
	if job.PlanJobID != "" {
		kv("Plan Job ID:", job.PlanJobID)
	}
	if job.ErrorMessage != nil && *job.ErrorMessage != "" {
		errStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
		doc.WriteString(keyStyle.Render("Error:"))
		doc.WriteString(errStyle.Render(*job.ErrorMessage))
		doc.WriteString("\n")
	}

	fmt.Println(doc.String())
}

func init() {
	jobsCmd.AddCommand(jobsGetCmd)
}
