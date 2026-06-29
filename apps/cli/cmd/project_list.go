// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
)

var projectListColumns = []string{"Project", "Env", "Status", "Provider", "Region", "Cost", "Updated"}

var listProjectsCmd = &cobra.Command{
	Use:   "list",
	Short: "List all projects",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		var configs []types.ConfigurationSummary

		ui.RunSpinner("Fetching projects...", func() {
			configs, err = api.NewClient(token).GetConfigurations()
		})

		if err != nil {
			failf("Failed to fetch projects: %v", err)
		}

		if interactiveTable(cmd) {
			if len(configs) == 0 {
				ui.Muted("No projects found. Create one through Alethia.")
				return
			}
			columns := make([]table.Column, len(projectListColumns))
			widths := []int{20, 14, 16, 10, 16, 10, 14}
			for i, title := range projectListColumns {
				columns[i] = table.Column{Title: title, Width: widths[i]}
			}
			plain := projectRows(configs)
			rows := make([]table.Row, len(plain))
			for i, r := range plain {
				rows[i] = table.Row(r)
			}
			m := ui.NewTableModel(columns, rows, "projects", "project", 0)
			if _, err := tea.NewProgram(m).Run(); err != nil {
				failf("Table error: %v", err)
			}
			return
		}

		if err := renderProjects(os.Stdout, outputFormat(cmd), configs); err != nil {
			fail(err)
		}
	},
}

// projectRows projects each configuration summary into a plain table row.
func projectRows(configs []types.ConfigurationSummary) [][]string {
	rows := make([][]string, len(configs))
	for i, v := range configs {
		provider := strings.ToUpper(v.CloudProvider)
		if provider == "" {
			provider = ui.SymbolDash
		}
		region := v.Region
		if region == "" {
			region = ui.SymbolDash
		}
		status := v.Status
		if status == "" {
			status = "DRAFT"
		}
		cost := ui.SymbolDash
		if v.EstimatedMonthlyCost != nil {
			cost = fmt.Sprintf("$%.0f/mo", *v.EstimatedMonthlyCost)
		}
		rows[i] = []string{
			v.ProjectName,
			v.EnvironmentStage,
			fmt.Sprintf("%s %s", ui.PlainStatusDot(status), strings.ToLower(status)),
			provider,
			region,
			cost,
			formatTime(v.UpdatedAt),
		}
	}
	return rows
}

// renderProjects writes the project list to out in the requested format.
func renderProjects(out io.Writer, format string, configs []types.ConfigurationSummary) error {
	if len(configs) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No projects found. Create one through Alethia."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: projectListColumns,
		Rows:    projectRows(configs),
	}, configs)
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ui.SymbolDash
	}
	if time.Since(t).Hours() < 24*7 {
		return humanize.Time(t)
	}
	return t.Format("2006-01-02")
}

func init() {
	projectCmd.AddCommand(listProjectsCmd)
}
