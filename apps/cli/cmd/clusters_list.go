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

var clusterListColumns = []string{"Project", "Cluster", "Version", "Status", "Nodes", "Region"}

var clusterListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all project clusters",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		var clusters []api.ClusterSummary

		ui.RunSpinner("Fetching clusters...", func() {
			clusters, err = apiClient.GetClusters()
		})

		if err != nil {
			failf("Failed to fetch clusters: %v", err)
		}

		if interactiveTable(cmd) {
			if len(clusters) == 0 {
				ui.Muted("No clusters found. Create a project with a cluster through Alethia.")
				return
			}
			columns := make([]table.Column, len(clusterListColumns))
			widths := []int{22, 20, 10, 14, 14, 14}
			for i, title := range clusterListColumns {
				columns[i] = table.Column{Title: title, Width: widths[i]}
			}
			plain := clusterRows(clusters)
			rows := make([]table.Row, len(plain))
			for i, r := range plain {
				rows[i] = table.Row(r)
			}
			m := ui.NewTableModel(columns, rows, "clusters", "project", 0)
			if _, err := tea.NewProgram(m).Run(); err != nil {
				failf("Table error: %v", err)
			}
			return
		}

		if err := renderClusters(os.Stdout, outputFormat(cmd), clusters); err != nil {
			fail(err)
		}
	},
}

// clusterRows projects each cluster summary into a plain table row.
func clusterRows(clusters []api.ClusterSummary) [][]string {
	rows := make([][]string, len(clusters))
	for i, c := range clusters {
		clusterName := c.ClusterName
		if clusterName == "" {
			clusterName = ui.SymbolDash
		}
		version := c.ClusterVersion
		if version == "" {
			version = ui.SymbolDash
		}
		nodes := fmt.Sprintf("%d/%d/%d", c.NodeMinSize, c.NodeDesiredSize, c.NodeMaxSize)
		projectLabel := c.ProjectName
		if c.Environment != "" {
			projectLabel += " (" + c.Environment + ")"
		}
		rows[i] = []string{
			projectLabel,
			clusterName,
			version,
			fmt.Sprintf("%s %s", ui.PlainStatusDot(c.Status), strings.ToLower(c.Status)),
			nodes,
			c.Region,
		}
	}
	return rows
}

// renderClusters writes the cluster list to out in the requested format.
func renderClusters(out io.Writer, format string, clusters []api.ClusterSummary) error {
	if len(clusters) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No clusters found. Create a project with a cluster through Alethia."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: clusterListColumns,
		Rows:    clusterRows(clusters),
	}, clusters)
}

func init() {
	clusterCmd.AddCommand(clusterListCmd)
}
