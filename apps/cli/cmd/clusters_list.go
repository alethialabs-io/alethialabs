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

		spinner.New().
			Title("Fetching clusters...").
			Action(func() {
				clusters, err = apiClient.GetClusters()
			}).Run()

		if err != nil {
			failf("Failed to fetch clusters: %v", err)
		}

		if len(clusters) == 0 {
			ui.Muted("No clusters found. Create a project with a cluster through Alethia.")
			return
		}

		columns := []table.Column{
			{Title: "Project", Width: 22},
			{Title: "Cluster", Width: 20},
			{Title: "Version", Width: 10},
			{Title: "Status", Width: 14},
			{Title: "Nodes", Width: 14},
			{Title: "Region", Width: 14},
		}

		rows := make([]table.Row, len(clusters))
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

			rows[i] = table.Row{
				projectLabel,
				clusterName,
				version,
				fmt.Sprintf("%s %s", ui.PlainStatusDot(c.Status), strings.ToLower(c.Status)),
				nodes,
				c.Region,
			}
		}

		m := ui.NewTableModel(columns, rows, "clusters", "project", 0)
		if _, err := tea.NewProgram(m).Run(); err != nil {
			failf("Table error: %v", err)
		}
	},
}

func init() {
	clusterCmd.AddCommand(clusterListCmd)
}
