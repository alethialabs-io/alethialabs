// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/dustin/go-humanize"
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
		ui.RunSpinner("Fetching cloud connections...", func() {
			identities, err = apiClient.GetCloudIdentities()
		})
		if err != nil {
			fail(err)
		}

		if interactiveTable(cmd) {
			if len(identities) == 0 {
				ui.Muted("No cloud accounts connected. Connect one with `alethia connector gcp|aws|azure`.")
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

// cloudIdentityRows projects each cloud identity into a plain table row.
func cloudIdentityRows(identities []api.CloudIdentity) [][]string {
	rows := make([][]string, len(identities))
	for i, id := range identities {
		rows[i] = []string{
			strings.ToUpper(id.Provider),
			id.Label,
			formatCreatedAt(id.CreatedAt),
		}
	}
	return rows
}

// renderCloudIdentities writes connected cloud accounts to out in the requested format.
func renderCloudIdentities(out io.Writer, format string, identities []api.CloudIdentity) error {
	if len(identities) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No cloud accounts connected. Connect one with `alethia connector gcp|aws|azure`."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: connectorListColumns,
		Rows:    cloudIdentityRows(identities),
	}, identities)
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
