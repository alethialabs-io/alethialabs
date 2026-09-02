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

var connectorListColumns = []string{"Provider", "Account", "Connected"}

var connectorListCmd = &cobra.Command{
	Use:   "list",
	Short: "List connected cloud accounts",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)

		var identities []api.CloudIdentity
		runSpinner("Fetching cloud connections...", func() {
			identities, err = apiClient.GetCloudIdentities()
		})
		if err != nil {
			fail(err)
		}

		if interactiveTable(cmd) {
			if len(identities) == 0 {
				ui.Muted(connectorEmptyStateHint())
				return
			}
			columns := []table.Column{
				{Title: "Provider", Width: 10},
				{Title: "Account", Width: 42},
				{Title: "Connected", Width: 18},
			}
			plain := cloudIdentityRows(identities)
			rows := make([]table.Row, len(plain))
			for i, r := range plain {
				rows[i] = table.Row(r)
			}
			m := ui.NewTableModel(columns, rows, "connections", "provider", 0)
			if _, err := tea.NewProgram(m).Run(); err != nil {
				failf("Table error: %v", err)
			}
			return
		}

		if err := renderCloudIdentities(os.Stdout, outputFormat(cmd), identities); err != nil {
			fail(err)
		}
	},
}

// connectorEmptyStateHint is the one empty-state sentence both renderings show.
//
// It was typed out twice and named "gcp|aws|azure" — a hand-written list of the providers,
// written before Alibaba and Hetzner existed and never revisited, so the empty state told a
// Hetzner user the CLI could not connect their cloud. The list now comes from the registered
// subcommands, which is the same place `alethia connector --help` reads it from.
func connectorEmptyStateHint() string {
	return "No cloud accounts connected. Connect one with `alethia connector " +
		strings.Join(connectorProviderNames(), "|") + "`."
}

// cloudIdentityRows projects each cloud identity into a plain table row.
func cloudIdentityRows(identities []api.CloudIdentity) [][]string {
	rows := make([][]string, len(identities))
	for i, id := range identities {
		rows[i] = []string{
			strings.ToUpper(id.Provider),
			id.Label,
			ui.RelativeTime(id.CreatedAt),
		}
	}
	return rows
}

// renderCloudIdentities writes connected cloud accounts to out in the requested format.
func renderCloudIdentities(out io.Writer, format string, identities []api.CloudIdentity) error {
	if len(identities) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(connectorEmptyStateHint()))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: connectorListColumns,
		Rows:    cloudIdentityRows(identities),
	}, identities)
}

func init() {
	connectorCmd.AddCommand(connectorListCmd)
}
