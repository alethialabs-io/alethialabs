// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var runnerListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all runners",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		var runners []api.Runner

		spinner.New().
			Title("Fetching runners...").
			Action(func() {
				runners, err = apiClient.GetRunners()
			}).Run()

		if err != nil {
			failf("Failed to fetch runners: %v", err)
		}

		if len(runners) == 0 {
			ui.Muted("No runners found. Deploy one with `alethia runner deploy`.")
			return
		}

		columns := []table.Column{
			{Title: "Name", Width: 24},
			{Title: "Operator", Width: 16},
			{Title: "Status", Width: 12},
			{Title: "Version", Width: 12},
			{Title: "Default", Width: 8},
			{Title: "Last Heartbeat", Width: 20},
		}

		rows := make([]table.Row, len(runners))
		for i, w := range runners {
			opLabel := runnerOperatorLabel(w)

			defaultLabel := ""
			if w.IsDefault {
				defaultLabel = ui.SymbolDefault
			}

			heartbeat := w.LastHeartbeat
			if heartbeat == "" {
				heartbeat = ui.SymbolDash
			}

			version := w.Version
			if version == "" {
				version = ui.SymbolDash
			}

			rows[i] = table.Row{
				w.Name,
				opLabel,
				fmt.Sprintf("%s %s", ui.PlainStatusDot(w.Status), strings.ToLower(w.Status)),
				version,
				defaultLabel,
				heartbeat,
			}
		}

		m := ui.NewTableModel(columns, rows, "runners", "name", 0)
		if _, err := tea.NewProgram(m).Run(); err != nil {
			failf("Table error: %v", err)
		}
	},
}

func init() {
	runnerCmd.AddCommand(runnerListCmd)
}
