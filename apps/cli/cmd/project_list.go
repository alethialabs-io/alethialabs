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
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
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

		runSpinner("Fetching projects...", func() {
			configs, err = api.NewClient(token).GetConfigurations()
		})

		if err != nil {
			failf("Failed to fetch projects: %v", err)
		}

		if interactiveTable(cmd) {
			if len(configs) == 0 {
				ui.Muted("No projects found. Create one with `alethia project create`.")
				return
			}
			// ui.ShowTable, like every other list in the CLI. This was the last list command
			// building its own bubbletea program: seven hardcoded column widths, its own
			// tea.NewProgram call, and a sort column named "project" where the header says
			// "Project" — so the one table a user is most likely to see first was the one
			// that did not size its columns to its contents. The shared entry point measures
			// them, truncates at the shared MaxColWidth, and sorts by the first column's real
			// title.
			if err := ui.ShowTable(projectListColumns, projectRows(configs), "projects"); err != nil {
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
		provider := strings.ToUpper(string(v.CloudProvider))
		if provider == "" {
			provider = ui.SymbolDash
		}
		region := v.Region
		if region == "" {
			region = ui.SymbolDash
		}
		status := string(v.Status)
		if status == "" {
			status = "DRAFT"
		}
		cost := ui.SymbolDash
		if v.EstimatedMonthlyCost != nil {
			// `$%.0f/mo` was the live half-to-even defect: Go's %f rounds half to EVEN, so an
			// estimate of 12.5 printed `$12/mo` against a billing page showing `$12.50`. Estimate
			// keeps the minor units above one unit, so the cell now reads `$12.50/mo`.
			//
			// USD is ASSUMED, as the `$` glyph before it was: `types.ConfigurationSummary` carries no
			// currency at all, so a euro org is shown a dollar sign. That is a WIRE gap, not a
			// rendering one — `cost show` gets this right because its response carries `Currency` —
			// and it is visible here rather than hidden inside a format string.
			cost = format.MonthlyRate(*v.EstimatedMonthlyCost, format.Estimate, "USD")
		}
		rows[i] = []string{
			v.ProjectName,
			string(v.EnvironmentStage),
			ui.StatusCell(status),
			provider,
			region,
			cost,
			ui.SmartTime(v.UpdatedAt),
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

func init() {
	projectCmd.AddCommand(listProjectsCmd)
}
