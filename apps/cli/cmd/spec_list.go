// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh/spinner"
	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
)

var listSpecsCmd = &cobra.Command{
	Use:   "list",
	Short: "List all specs",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		var configs []types.ConfigurationSummary

		spinner.New().
			Title("Fetching specs...").
			Action(func() {
				configs, err = api.NewClient(token).GetConfigurations()
			}).Run()

		if err != nil {
			failf("Failed to fetch specs: %v", err)
		}

		if len(configs) == 0 {
			ui.Muted("No specs found. Create one through Alethia.")
			return
		}

		columns := []table.Column{
			{Title: "Project", Width: 20},
			{Title: "Env", Width: 14},
			{Title: "Status", Width: 16},
			{Title: "Provider", Width: 10},
			{Title: "Region", Width: 16},
			{Title: "Cost", Width: 10},
			{Title: "Updated", Width: 14},
		}

		rows := make([]table.Row, len(configs))
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

			rows[i] = table.Row{
				v.ProjectName,
				v.EnvironmentStage,
				fmt.Sprintf("%s %s", ui.PlainStatusDot(status), strings.ToLower(status)),
				provider,
				region,
				cost,
				formatTime(v.UpdatedAt),
			}
		}

		m := ui.NewTableModel(columns, rows, "specs", "project", 0)
		if _, err := tea.NewProgram(m).Run(); err != nil {
			failf("Table error: %v", err)
		}
	},
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
	specCmd.AddCommand(listSpecsCmd)
}
