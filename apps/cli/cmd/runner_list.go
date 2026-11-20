// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
)

var runnerListColumns = []string{"Name", "Operator", "Status", "Version", "Default", "Last Heartbeat"}

var runnerListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the runners that can take your jobs",
	Long: `Lists every runner the active organization can see: its name, who operates it, whether it is
online, its version and its last heartbeat. The names are the ones the other runner commands
take.

A runner takes jobs only while it is ONLINE. With none online and no managed fleet, a deploy
waits; "alethia runner register" adds a runner you run yourself.

--output json prints the records as an array, and --output csv the wire values of the columns.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		p := printerFor(cmd)
		var list []api.Runner

		runSpinner("Fetching runners...", func() {
			list, err = apiClient.GetRunners()
		})

		if err != nil {
			fail(fmt.Errorf("failed to fetch runners: %w", err))
		}

		if interactiveTable(cmd) && len(list) > 0 {
			columns := make([]table.Column, len(runnerListColumns))
			widths := []int{24, 16, 12, 12, 8, 20}
			for i, title := range runnerListColumns {
				columns[i] = table.Column{Title: title, Width: widths[i]}
			}
			plain := runnerRows(list, ui.FormatTable)
			rows := make([]table.Row, len(plain))
			for i, r := range plain {
				rows[i] = table.Row(r)
			}
			m := ui.NewTableModel(columns, rows, "runners", "name", 0)
			if _, err := tea.NewProgram(m).Run(); err != nil {
				fail(fmt.Errorf("table error: %w", err))
			}
			return
		}

		if err := renderRunners(p.Out, p.Format, list); err != nil {
			fail(err)
		}
	},
}

// runnersEmptyState is what an empty runner list says: how the first runner is added, and why it
// is not `runner deploy`.
//
// Building a runner is itself a job, so with no runner online a deploy has nothing to run it.
// The first runner is therefore always a registered one — or, on the hosted control plane, none
// at all, because the managed fleet there takes the jobs and is not listed to its tenants.
func runnersEmptyState() string {
	first := "No runners yet."
	if hostedControlPlane(WebOrigin()) {
		first = "No runners of your own. The Alethia managed fleet runs your jobs, so you do not need one."
	}
	return first + " To add one, run `alethia runner register`: it registers a runner you run yourself, on any cloud, " +
		"and needs nothing to exist already. `alethia runner deploy` builds one inside your " +
		runners.DeployProvidersLabel() + " account, but only once a runner is online to run that build."
}

// runnerRows projects each runner into a plain table row for the given output format.
//
// Five of the six cells were humanised unconditionally and Render writes these rows verbatim into
// its CSV branch, so a script reading `runner list -o csv` received a `◆` for the default runner, a
// `● active` status welded to its glyph, `3 minutes ago` where a timestamp belongs, and — the one
// that loses data outright — `self·hetzner`, which is api.Runner's Operator and Provisioning fields
// joined by U+00B7. The Operator column's machine form is the Operator field; a script that wants
// the provisioner reads `-o json`, where it has never stopped being its own key.
func runnerRows(list []api.Runner, outFmt string) [][]string {
	rows := make([][]string, len(list))
	for i, w := range list {
		rows[i] = []string{
			w.Name,
			ui.Cell(outFmt, w.Operator, runnerOperatorLabel(w)),
			ui.Cell(outFmt, w.Status, ui.StatusCell(w.Status)),
			ui.Cell(outFmt, w.Version, ui.OrDash(w.Version)),
			ui.Cell(outFmt, ui.WireBool(w.IsDefault), ui.DefaultCell(w.IsDefault)),
			ui.Cell(outFmt, w.LastHeartbeat, ui.RelativeTime(w.LastHeartbeat)),
		}
	}
	return rows
}

// renderRunners writes the runner list to out in the requested format.
func renderRunners(out io.Writer, outFmt string, list []api.Runner) error {
	if len(list) == 0 && outFmt == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(runnersEmptyState()))
		return nil
	}
	if list == nil {
		// An empty list is an empty array for a program, never null.
		list = []api.Runner{}
	}
	return ui.Render(out, outFmt, ui.TableSpec{
		Columns: runnerListColumns,
		Rows:    runnerRows(list, outFmt),
	}, list)
}

func init() {
	runnerCmd.AddCommand(runnerListCmd)
}
