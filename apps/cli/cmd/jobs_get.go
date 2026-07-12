// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
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

		ui.RunSpinner("Fetching job details...", func() {
			job, err = apiClient.GetJob(jobID)
		})

		if err != nil {
			failf("Failed to fetch job: %v", err)
		}

		if err := renderJob(os.Stdout, outputFormat(cmd), job); err != nil {
			fail(err)
		}
	},
}

// renderJob writes a single job to out: a bordered KV card for the table format,
// the typed object for json, Field/Value rows for csv.
func renderJob(out io.Writer, format string, job *api.ProvisionJob) error {
	return ui.RenderCard(out, format, "Job "+job.ID, jobFieldRows(job), job)
}

// jobFieldRows returns the present-only key/value fields of a job.
func jobFieldRows(job *api.ProvisionJob) [][]string {
	rows := [][]string{
		{"ID", job.ID},
		{"Type", job.JobType},
		{"Status", job.Status},
		{"Created", job.CreatedAt.Format("2006-01-02 15:04:05")},
	}
	if job.Provider != "" {
		rows = append(rows, []string{"Provider", job.Provider})
	}
	if job.StartedAt != nil {
		rows = append(rows, []string{"Started", job.StartedAt.Format("2006-01-02 15:04:05")})
	}
	if job.CompletedAt != nil {
		rows = append(rows, []string{"Completed", job.CompletedAt.Format("2006-01-02 15:04:05")})
	}
	if job.StartedAt != nil {
		rows = append(rows, []string{"Duration", formatDuration(job.StartedAt, job.CompletedAt)})
	}
	if job.ProjectID != "" {
		rows = append(rows, []string{"Project ID", job.ProjectID})
	}
	if job.RunnerID != "" {
		rows = append(rows, []string{"Runner ID", job.RunnerID})
	}
	if job.PlanJobID != "" {
		rows = append(rows, []string{"Plan Job ID", job.PlanJobID})
	}
	if v := verifySummary(job.ExecutionMetadata); v != "" {
		rows = append(rows, []string{"Verify", v})
	}
	if job.ErrorMessage != nil && *job.ErrorMessage != "" {
		rows = append(rows, []string{"Error", *job.ErrorMessage})
	}
	return rows
}

// verifySummary renders the elench verify gate result (attached to a job's
// execution_metadata as "verify_result") as a compact "verdict (n fail, n pass…)"
// line. Returns "" when the job carries no verify report.
func verifySummary(meta *map[string]interface{}) string {
	if meta == nil {
		return ""
	}
	raw, ok := (*meta)["verify_result"]
	if !ok {
		return ""
	}
	vr, ok := raw.(map[string]interface{})
	if !ok {
		return ""
	}
	verdict, _ := vr["verdict"].(string)
	if verdict == "" {
		return ""
	}
	var parts []string
	if s, ok := vr["summary"].(map[string]interface{}); ok {
		add := func(label, key string) {
			if n, ok := s[key].(float64); ok && n > 0 {
				parts = append(parts, fmt.Sprintf("%d %s", int(n), label))
			}
		}
		add("fail", "fail")
		add("pass", "pass")
		add("warn", "warn")
		add("n/a", "not_evaluable")
	}
	if len(parts) > 0 {
		return fmt.Sprintf("%s (%s)", verdict, strings.Join(parts, ", "))
	}
	return verdict
}

func init() {
	jobsCmd.AddCommand(jobsGetCmd)
}
