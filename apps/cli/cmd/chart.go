// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var chartCmd = &cobra.Command{
	Use:     "chart",
	Aliases: []string{"charts"},
	Short:   "Inspect a project's BYO Helm charts",
	Long: `BYO charts are your OWN Helm charts (pulled from a connected git repo) deployed into an
environment via ArgoCD, alongside the marketplace add-ons. List the charts attached to an
environment (defaults to the project's default environment; pass --env for another).`,
}

var chartListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the BYO Helm charts attached to a project environment",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var view *api.ProjectByoCharts
			ui.RunSpinner("Fetching charts...", func() {
				view, err = client.GetProjectByoCharts(project, env)
			})
			if err != nil {
				failf("Failed to list charts: %v", err)
			}
			if view == nil || len(view.Charts) == 0 {
				ui.Muted("No BYO charts attached.")
				return
			}
			_ = ui.ShowTable(chartColumns, chartRows(view.Charts), "charts")
			return
		}
		if err := runChartList(client, os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to list charts: %v", err)
		}
	},
}

var chartColumns = []string{"Chart", "Repo", "Path", "Ref", "Status", "Scan"}

// chartRows projects BYO charts into plain table cells.
func chartRows(charts []api.ByoChart) [][]string {
	rows := make([][]string, len(charts))
	for i, c := range charts {
		rows[i] = []string{c.ID, c.RepoURL, c.ChartPath, c.Ref, c.Status, c.ScanStatus}
	}
	return rows
}

// runChartList fetches and renders a project environment's BYO charts. json emits the whole view;
// table/csv emit the chart rows.
func runChartList(c apiClient, out io.Writer, format, project, env string) error {
	view, err := c.GetProjectByoCharts(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, view)
	}
	if (view == nil || len(view.Charts) == 0) && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No BYO charts attached."))
		return nil
	}
	var charts []api.ByoChart
	if view != nil {
		charts = view.Charts
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: chartColumns,
		Rows:    chartRows(charts),
	}, charts)
}

func init() {
	chartCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	chartCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	chartCmd.AddCommand(chartListCmd)
	rootCmd.AddCommand(chartCmd)
}
