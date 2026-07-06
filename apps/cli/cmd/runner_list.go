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
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
)

var runnerListColumns = []string{"Name", "Operator", "Status", "Version", "Default", "Last Heartbeat"}

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

		ui.RunSpinner("Fetching runners...", func() {
			runners, err = apiClient.GetRunners()
		})

		if err != nil {
			failf("Failed to fetch runners: %v", err)
		}

		if interactiveTable(cmd) {
			if len(runners) == 0 {
				ui.Muted("No runners found. Deploy one with `alethia runner deploy`.")
				return
			}
			columns := make([]table.Column, len(runnerListColumns))
			widths := []int{24, 16, 12, 12, 8, 20}
			for i, title := range runnerListColumns {
				columns[i] = table.Column{Title: title, Width: widths[i]}
			}
			plain := runnerRows(runners)
			rows := make([]table.Row, len(plain))
			for i, r := range plain {
				rows[i] = table.Row(r)
			}
			m := ui.NewTableModel(columns, rows, "runners", "name", 0)
			if _, err := tea.NewProgram(m).Run(); err != nil {
				failf("Table error: %v", err)
			}
			return
		}

		if err := renderRunners(os.Stdout, outputFormat(cmd), runners); err != nil {
			fail(err)
		}
	},
}

// runnerRows projects each runner into a plain table row.
func runnerRows(runners []api.Runner) [][]string {
	rows := make([][]string, len(runners))
	for i, w := range runners {
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
		rows[i] = []string{
			w.Name,
			runnerOperatorLabel(w),
			fmt.Sprintf("%s %s", ui.PlainStatusDot(w.Status), strings.ToLower(w.Status)),
			version,
			defaultLabel,
			heartbeat,
		}
	}
	return rows
}

// renderRunners writes the runner list to out in the requested format.
func renderRunners(out io.Writer, format string, runners []api.Runner) error {
	if len(runners) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No runners found. Deploy one with `alethia runner deploy`."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: runnerListColumns,
		Rows:    runnerRows(runners),
	}, runners)
}

func init() {
	runnerCmd.AddCommand(runnerListCmd)
}
