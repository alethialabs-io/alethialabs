// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
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
	Long: `List the cloud accounts connected to the active organization: the cloud, the
account's label and when it was connected.

Use it to see what a project can deploy into, or to read a connection's id with
--output json. On a terminal the table can be sorted and navigated.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		p := resultPrinter(cmd)
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		identities, err := listCloudIdentities(api.NewClient(token))
		if err != nil {
			fail(err)
		}

		if interactiveTable(cmd) && len(identities) > 0 {
			if err := showCloudIdentities(identities); err != nil {
				fail(fmt.Errorf("could not draw the table: %w", err))
			}
			return
		}
		if err := renderCloudIdentities(p, identities); err != nil {
			fail(err)
		}
	},
}

// showCloudIdentities draws the navigable table of connected accounts on a terminal.
func showCloudIdentities(identities []api.CloudIdentity) error {
	columns := []table.Column{
		{Title: "Provider", Width: 10},
		{Title: "Account", Width: 42},
		{Title: "Connected", Width: 18},
	}
	plain := cloudIdentityRows(identities, ui.FormatTable)
	rows := make([]table.Row, len(plain))
	for i, r := range plain {
		rows[i] = table.Row(r)
	}
	m := ui.NewTableModel(columns, rows, "connections", "provider", 0)
	_, err := tea.NewProgram(m).Run()
	return err
}

// connectorEmptyStateHint is the one empty-state sentence a person reads. The clouds it names are
// the ones `alethia connector` offers, so it cannot name a command the help does not list.
func connectorEmptyStateHint() string {
	return "No cloud accounts connected. Connect one with `alethia connector " +
		strings.Join(connectorProviderNames(), "|") + "`."
}

// cloudIdentityRows projects each cloud identity into a plain table row for the given output format.
//
// Two of the three cells were display decisions reaching a script through Render's verbatim CSV
// branch. The Provider cell is the one worth naming: `strings.ToUpper` makes this the ONLY surface
// in the product that spells a provider `AWS`. It is the same string `alethia connector aws` takes,
// the same string `-o json` marshals, and the same string every other table prints in lower case —
// so a script matching on it had to know that this one column shouts.
func cloudIdentityRows(identities []api.CloudIdentity, outFmt string) [][]string {
	rows := make([][]string, len(identities))
	for i, id := range identities {
		rows[i] = []string{
			ui.Cell(outFmt, id.Provider, strings.ToUpper(id.Provider)),
			id.Label,
			ui.Cell(outFmt, id.CreatedAt, ui.RelativeTime(id.CreatedAt)),
		}
	}
	return rows
}

// renderCloudIdentities writes the connected cloud accounts on the Printer's stdout in its format.
//
// With nothing connected, a person is told how to connect an account, on stderr: stdout stays
// empty, so a pipeline reading the table sees no rows and no sentence. json and csv always carry
// the document, which for no accounts is an empty list and a header row.
func renderCloudIdentities(p *Printer, identities []api.CloudIdentity) error {
	if identities == nil {
		identities = []api.CloudIdentity{}
	}
	if len(identities) == 0 && (p.Format == "" || p.Format == ui.FormatTable) {
		p.Note(connectorEmptyStateHint())
		return nil
	}
	return p.Table(ui.TableSpec{
		Columns: connectorListColumns,
		Rows:    cloudIdentityRows(identities, p.Format),
	}, identities)
}

func init() {
	connectorCmd.AddCommand(connectorListCmd)
}
