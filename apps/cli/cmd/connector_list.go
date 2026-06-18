// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh/spinner"
	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
)

var connectorListCmd = &cobra.Command{
	Use:   "list",
	Short: "List connected cloud accounts",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		apiClient := api.NewClient(token)

		var identities []api.CloudIdentity
		spinner.New().
			Title("Fetching cloud connections...").
			Action(func() {
				identities, err = apiClient.GetCloudIdentities()
			}).Run()
		if err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}

		if len(identities) == 0 {
			ui.Muted("No cloud accounts connected. Connect one with `alethia connector gcp|aws|azure`.")
			return
		}

		columns := []table.Column{
			{Title: "Provider", Width: 10},
			{Title: "Account", Width: 42},
			{Title: "Connected", Width: 18},
		}
		rows := make([]table.Row, len(identities))
		for i, id := range identities {
			rows[i] = table.Row{
				strings.ToUpper(id.Provider),
				id.Label,
				formatCreatedAt(id.CreatedAt),
			}
		}

		m := ui.NewTableModel(columns, rows, "connections", "provider", 0)
		if _, err := tea.NewProgram(m).Run(); err != nil {
			ui.Error(fmt.Sprintf("Table error: %v", err))
			os.Exit(1)
		}
	},
}

// formatCreatedAt renders an ISO timestamp as a relative time, falling back to
// the raw value if it cannot be parsed.
func formatCreatedAt(raw string) string {
	if raw == "" {
		return ui.SymbolDash
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return humanize.Time(t)
}

func init() {
	connectorCmd.AddCommand(connectorListCmd)
}
