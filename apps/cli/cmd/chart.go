// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var chartCmd = &cobra.Command{
	Use:     "chart",
	Aliases: []string{"charts"},
	Short:   "Attach, scan and inspect a project's BYO Helm charts",
	Long: `BYO charts are your own Helm charts, from a git repository or an OCI registry, deployed into
an environment by ArgoCD beside the marketplace add-ons.

Attach one with "alethia chart attach", scan it with "alethia chart scan" (an unscanned chart is
refused at deploy), list them with "alethia chart list", and detach one with "alethia chart
detach". --project and --env work on every subcommand; the environment defaults to the project's
default.`,
}

var chartListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the BYO Helm charts attached to a project environment",
	Args:  cobra.NoArgs,
	Long: `Lists the BYO Helm charts attached to one environment: each chart's id, repository, path, ref,
status and scan state. The ids are the ones "alethia chart scan" and "alethia chart detach" take.

Use it to check that a chart is scanned before a deploy. Name the project with --project; omit it
on a terminal and you are asked which. With nobody to ask, it is required (exit 9).

--output json prints the whole view, and --output csv the chart rows.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		// Format first, then the picker: interactiveTable is both the "may I draw a rich table"
		// question and the "may I open a form on stdout" one, and they have the same answer.
		p := printerFor(cmd)
		rich := interactiveTable(cmd)
		project, err := byoProject(cmd, token, rich)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if rich {
			var view *api.ProjectByoCharts
			runSpinner("Fetching charts...", func() {
				view, err = client.GetProjectByoCharts(project, env)
			})
			if err != nil {
				fail(fmt.Errorf("list charts: %w", err))
			}
			if view == nil || len(view.Charts) == 0 {
				fmt.Fprintln(p.Out, ui.MutedStyle.Render("No BYO charts attached."))
				return
			}
			_ = ui.ShowTable(chartColumns, chartRows(view.Charts, ui.FormatTable), "charts")
			return
		}
		if err := runChartList(client, p.Out, p.Format, project, env); err != nil {
			fail(fmt.Errorf("list charts: %w", err))
		}
	},
}

var chartColumns = []string{"Chart", "Repo", "Path", "Ref", "Status", "Scan"}

// chartRows projects BYO charts into plain table cells.
//
// OrDash on the two OPTIONAL cells, for a person. An OCI chart carries no path and a chart
// tracking its repository's default branch carries no ref, and both rendered as an empty cell —
// which reads as missing data rather than as "this chart does not have one".
//
// outFmt is taken for the reason ui.Render's doc states: its CSV branch writes these rows
// VERBATIM, so the dash would reach a script as `—` (U+2014). That is exactly the ambiguity the
// glyph resolves for a person and exactly the one it CREATES for a parser, which already reads an
// empty cell as absent and would now have to know one product's sentinel.
func chartRows(charts []api.ByoChart, outFmt string) [][]string {
	rows := make([][]string, len(charts))
	for i, c := range charts {
		path, ref := c.ChartPath, c.Ref
		if ui.HumanReadable(outFmt) {
			path, ref = ui.OrDash(path), ui.OrDash(ref)
		}
		rows[i] = []string{c.ID, c.RepoURL, path, ref, c.Status, c.ScanStatus}
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
		Rows:    chartRows(charts, format),
	}, charts)
}

func init() {
	chartCmd.PersistentFlags().StringP("project", "p", "", byoFlagUsage("alethia chart", byoKeyProject))
	chartCmd.PersistentFlags().StringP("env", "e", "", byoFlagUsage("alethia chart", byoKeyEnv))
	chartCmd.AddCommand(chartListCmd)
	rootCmd.AddCommand(chartCmd)
}
