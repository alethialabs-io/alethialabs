// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
)

var jobListColumns = []string{"Type", "Status", "Project", "Runner", "Created", "Duration"}

var (
	jobsListStatus string
	jobsListLimit  int
)

// jobTypeLabels maps every provision_job_type to a friendly table label. Keyed by the
// generated types.JobType constants so a removed enum value is a compile error here; a
// test (TestJobTypeLabels_CoverAllJobTypes) asserts every job type has a label, so an
// added one fails the build.
var jobTypeLabels = map[string]string{
	string(types.JobTypePlan):          "Plan",
	string(types.JobTypeDeploy):        "Deploy",
	string(types.JobTypeDestroy):       "Destroy",
	string(types.JobTypeAnalyzeRepo):   "Analyze Repo",
	string(types.JobTypeDetectDrift):   "Detect Drift",
	string(types.JobTypeAudit):         "Audit",
	string(types.JobTypeDeployRunner):  "Deploy Runner",
	string(types.JobTypeUpdateRunner):  "Update Runner",
	string(types.JobTypeDestroyRunner): "Destroy Runner",
	string(types.JobTypeChartScan):     "Chart Scan",
}

var jobsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all provisioning jobs",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		pageSize := jobsListLimit
		if pageSize <= 0 {
			pageSize = 20
		}

		var page *api.JobsPage

		ui.RunSpinner("Fetching jobs...", func() {
			page, err = apiClient.GetJobs(jobsListStatus, pageSize, 0)
		})

		if err != nil {
			failf("Failed to fetch jobs: %v", err)
		}

		if !interactiveTable(cmd) {
			if err := renderJobs(os.Stdout, outputFormat(cmd), page.Jobs); err != nil {
				fail(err)
			}
			return
		}

		if page.Total == 0 {
			ui.Muted("No jobs found.")
			return
		}

		columns := jobColumns()
		rows := jobRows(page.Jobs)

		m := ui.NewPaginatedTableModel(columns, rows, "jobs", page.Total, pageSize)

		p := tea.NewProgram(jobsPaginatedModel{
			PaginatedTableModel: m,
			apiClient:           apiClient,
			pageSize:            pageSize,
			status:              jobsListStatus,
		})
		if _, err := p.Run(); err != nil {
			failf("Table error: %v", err)
		}
	},
}

// renderJobs writes a page of jobs to out in the requested format. Pagination is
// interactive-only; non-interactive output returns up to --limit jobs.
func renderJobs(out io.Writer, format string, jobs []api.ProvisionJob) error {
	if len(jobs) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No jobs found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: jobListColumns,
		Rows:    jobRowsPlain(jobs),
	}, jobs)
}

// jobRowsPlain projects each job into a plain table row.
func jobRowsPlain(jobs []api.ProvisionJob) [][]string {
	rows := make([][]string, len(jobs))
	for i, j := range jobs {
		typeLabel := jobTypeLabels[j.JobType]
		if typeLabel == "" {
			typeLabel = j.JobType
		}

		project := j.ProjectName
		if project == "" && j.ProjectID != "" {
			project = truncID(j.ProjectID)
		}
		if project == "" {
			project = ui.SymbolDash
		}

		runner := j.RunnerName
		if runner == "" && j.RunnerID != "" {
			runner = truncID(j.RunnerID)
		}
		if runner == "" {
			runner = ui.SymbolDash
		}

		rows[i] = []string{
			typeLabel,
			j.Status,
			project,
			runner,
			humanize.Time(j.CreatedAt),
			formatDuration(j.StartedAt, j.CompletedAt),
		}
	}
	return rows
}

func truncID(id string) string {
	if len(id) > 8 {
		return id[:8] + "…"
	}
	return id
}

func formatDuration(started, completed *time.Time) string {
	if started == nil {
		return ui.SymbolDash
	}
	end := time.Now()
	suffix := "…"
	if completed != nil {
		end = *completed
		suffix = ""
	}
	d := end.Sub(*started)
	if d < time.Minute {
		return fmt.Sprintf("%ds%s", int(d.Seconds()), suffix)
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm %ds%s", int(d.Minutes()), int(d.Seconds())%60, suffix)
	}
	return fmt.Sprintf("%dh %dm%s", int(d.Hours()), int(d.Minutes())%60, suffix)
}

func init() {
	jobsCmd.AddCommand(jobsListCmd)
	jobsListCmd.Flags().StringVar(&jobsListStatus, "status", "", "Filter by status (QUEUED, CLAIMED, PROCESSING, SUCCESS, FAILED, CANCELLED)")
	jobsListCmd.Flags().IntVarP(&jobsListLimit, "limit", "n", 20, "Jobs per page")
}
