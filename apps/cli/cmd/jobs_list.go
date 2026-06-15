// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"math"
	"os"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh/spinner"
	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
)

var (
	jobsListStatus     string
	jobsListVineyardID string
	jobsListLimit      int
)

var jobTypeLabels = map[string]string{
	"PLAN":            "Plan",
	"DEPLOY":          "Deploy",
	"DESTROY":         "Destroy",
	"CONNECTION_TEST": "Test Conn.",
	"FETCH_RESOURCES": "Fetch Res.",
	"DEPLOY_WORKER":   "Deploy Tendril",
	"UPDATE_WORKER":   "Update Tendril",
	"DESTROY_WORKER":  "Destroy Tendril",
}

var jobsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all provisioning jobs",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)
		pageSize := jobsListLimit
		if pageSize <= 0 {
			pageSize = 20
		}

		var page *api.JobsPage

		spinner.New().
			Title("Fetching jobs...").
			Action(func() {
				page, err = apiClient.GetJobs(jobsListStatus, jobsListVineyardID, pageSize, 0)
			}).Run()

		if err != nil {
			ui.Error(fmt.Sprintf("Failed to fetch jobs: %v", err))
			os.Exit(1)
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
			vineyardID:          jobsListVineyardID,
		})
		if _, err := p.Run(); err != nil {
			ui.Error(fmt.Sprintf("Table error: %v", err))
			os.Exit(1)
		}
	},
}

type jobsPaginatedModel struct {
	ui.PaginatedTableModel
	apiClient  *api.Client
	pageSize   int
	status     string
	vineyardID string
}

func (m jobsPaginatedModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case ui.PageChangedMsg:
		return m, m.fetchPage(msg.Page)
	}
	updated, cmd := m.PaginatedTableModel.Update(msg)
	m.PaginatedTableModel = updated.(ui.PaginatedTableModel)
	return m, cmd
}

func (m jobsPaginatedModel) fetchPage(page int) tea.Cmd {
	return func() tea.Msg {
		offset := (page - 1) * m.pageSize
		result, err := m.apiClient.GetJobs(m.status, m.vineyardID, m.pageSize, offset)
		if err != nil {
			return nil
		}
		totalPages := int(math.Ceil(float64(result.Total) / float64(m.pageSize)))
		if totalPages < 1 {
			totalPages = 1
		}
		return ui.PageDataMsg{
			Rows:       jobRows(result.Jobs),
			Total:      result.Total,
			Page:       page,
			TotalPages: totalPages,
		}
	}
}

func jobColumns() []table.Column {
	return []table.Column{
		{Title: "Type", Width: 16},
		{Title: "Status", Width: 12},
		{Title: "Vine", Width: 18},
		{Title: "Tendril", Width: 16},
		{Title: "Created", Width: 16},
		{Title: "Duration", Width: 10},
	}
}

func jobRows(jobs []api.ProvisionJob) []table.Row {
	rows := make([]table.Row, len(jobs))
	for i, j := range jobs {
		typeLabel := jobTypeLabels[j.JobType]
		if typeLabel == "" {
			typeLabel = j.JobType
		}

		vine := j.VineName
		if vine == "" && j.VineID != "" {
			vine = truncID(j.VineID)
		}
		if vine == "" {
			vine = ui.SymbolDash
		}

		tendril := j.WorkerName
		if tendril == "" && j.WorkerID != "" {
			tendril = truncID(j.WorkerID)
		}
		if tendril == "" {
			tendril = ui.SymbolDash
		}

		rows[i] = table.Row{
			typeLabel,
			j.Status,
			vine,
			tendril,
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
	jobsListCmd.Flags().StringVar(&jobsListVineyardID, "vineyard-id", "", "Filter by vineyard ID")
	jobsListCmd.Flags().IntVarP(&jobsListLimit, "limit", "n", 20, "Jobs per page")
}
