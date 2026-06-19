// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
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
	Short: "List all spec clusters",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)
		var clusters []api.SpecCluster

		spinner.New().
			Title("Fetching clusters...").
			Action(func() {
				clusters, err = apiClient.GetSpecClusters()
			}).Run()

		if err != nil {
			ui.Error(fmt.Sprintf("Failed to fetch clusters: %v", err))
			os.Exit(1)
		}

		if len(clusters) == 0 {
			ui.Muted("No clusters found. Create a spec with a cluster through Alethia.")
			return
		}

		columns := []table.Column{
			{Title: "Spec", Width: 22},
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

			specLabel := c.SpecProjectName
			if c.SpecEnvironment != "" {
				specLabel += " (" + c.SpecEnvironment + ")"
			}

			rows[i] = table.Row{
				specLabel,
				clusterName,
				version,
				fmt.Sprintf("%s %s", ui.PlainStatusDot(c.Status), strings.ToLower(c.Status)),
				nodes,
				c.SpecRegion,
			}
		}

		m := ui.NewTableModel(columns, rows, "clusters", "spec", 0)
		if _, err := tea.NewProgram(m).Run(); err != nil {
			ui.Error(fmt.Sprintf("Table error: %v", err))
			os.Exit(1)
		}
	},
}

func init() {
	clusterCmd.AddCommand(clusterListCmd)
}
