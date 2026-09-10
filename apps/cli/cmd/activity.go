// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var activityLimit int

var activityCmd = &cobra.Command{
	Use:   "activity",
	Short: "Show the organization's delivery/activity log",
	Long: `Read the active organization's activity log — every recorded action and
denial, newest first — including alert deliveries. Use -n/--limit to cap the
number of rows.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		limit, err := promptActivityRows(cmd, activityLimit)
		if err != nil {
			fail(err)
		}
		if interactiveTable(cmd) {
			var entries []api.ActivityEntry
			runSpinner("Fetching activity...", func() { entries, err = client.ListActivity(limit) })
			if err != nil {
				failf("Failed to read activity: %v", err)
			}
			if len(entries) == 0 {
				ui.Muted("No activity found.")
				return
			}
			_ = ui.ShowTable(activityColumns, activityRows(entries, ui.FormatTable), "activity")
			return
		}
		if err := runActivity(client, os.Stdout, outputFormat(cmd), limit); err != nil {
			failf("Failed to read activity: %v", err)
		}
	},
}

// activityRowLadder is what the row-count question offers when nobody passes `-n`.
//
// A ladder rather than a typed number, because every answer to "how many rows" is a round one and a
// select cannot be answered with a value the route refuses. It is deliberately NOT a validation
// set: `-n 137` still reaches the server, which is the only side that knows what it will serve.
var activityRowLadder = []int{25, 50, 100, 200, 500}

// promptActivityRows asks how many entries to read back.
//
// The limit HAS a default, so this reads canPromptForm rather than requireInteractiveForm — the
// rule output.go states for every defaulted field: a scripted caller is never REFUSED for omitting
// `-n`, because the flag contract is complete without it, and a person at a terminal is still
// asked, because a default is rarely what they meant. `alethia activity --no-input` therefore reads
// exactly the rows it read before this form existed.
//
// The flag's own value is what seeds the select, so the cursor opens on the answer `-n` would have
// given and a bare Enter changes nothing. It is INSERTED into the ladder when the ladder does not
// already carry it, because a picker that cannot offer the current value turns Enter into a silent
// change of it — which is the one thing a seeded form must never do.
func promptActivityRows(cmd *cobra.Command, limit int) (int, error) {
	if cmd.Flags().Changed("limit") || !canPromptForm() {
		return limit, nil
	}
	f := mustGovField("alethia activity", fieldKeyGovLimit)
	options := make([]huh.Option[int], 0, len(activityRowLadder)+1)
	for _, n := range activityRowsOffered(limit) {
		options = append(options, huh.NewOption(fmt.Sprintf("%d rows", n), n))
	}
	chosen := limit
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return limit, err
	}
	return chosen, nil
}

// activityRowsOffered is the ladder with the current value merged in, ascending.
func activityRowsOffered(limit int) []int {
	offered := make([]int, 0, len(activityRowLadder)+1)
	inserted := false
	for _, n := range activityRowLadder {
		if !inserted && limit < n {
			offered = append(offered, limit)
			inserted = true
		}
		if n == limit {
			inserted = true
		}
		offered = append(offered, n)
	}
	if !inserted {
		offered = append(offered, limit)
	}
	return offered
}

var activityColumns = []string{"Time", "Actor", "Action", "Resource", "Decision", "Reason"}

// activityCSVColumns is the machine table, and it is one column WIDER than the human one.
//
// The Resource cell a reader sees is `project 4f3c1a92…` — a type and an id joined by a space, with
// the id cut to eight characters and an ellipsis appended. That is the one cell in the CLI that
// destroys data rather than merely inconveniencing a parser: a script reading a resource id out of
// `-o csv` got eight characters and a U+2026, and no amount of parsing recovers the rest.
//
// Neither half can be dropped, and there is no separator to weld them with that a script could
// split on safely — a space appears inside neither field today, which is exactly the kind of
// guarantee that quietly stops being true. So the machine rendering carries the two fields in two
// columns, and says so in its own header row. `-o csv` and `-o table` describing the same rows with
// different columns is not a divergence: the header is the contract, and a machine format that
// cannot state its own shape is the problem being fixed here.
var activityCSVColumns = []string{"Time", "Actor", "Action", "Resource", "Resource ID", "Decision", "Reason"}

// activityRows projects activity entries into plain table rows for the given output format. The
// actor prefers the email (falling back to the actor id); the decision renders allow/deny. The
// Reason column is the point of a deny row, so it is always shown.
//
// Under FormatCSV the row carries activityCSVColumns' seven cells; otherwise the human six.
func activityRows(entries []api.ActivityEntry, outFmt string) [][]string {
	rows := make([][]string, len(entries))
	for i, e := range entries {
		actor := e.ActorEmail
		if actor == "" {
			actor = e.ActorID
		}
		ts := ui.Cell(outFmt, e.Ts, ui.RelativeTime(e.Ts))
		decision := decisionLabel(e.Decision)
		reason := ui.Cell(outFmt, e.Reason, ui.OrDash(e.Reason))
		if outFmt == ui.FormatCSV {
			rows[i] = []string{ts, actor, e.Action, e.ResourceType, e.ResourceID, decision, reason}
			continue
		}
		resource := e.ResourceType
		if e.ResourceID != "" {
			resource += " " + ui.TruncID(e.ResourceID)
		}
		rows[i] = []string{ts, actor, e.Action, resource, decision, reason}
	}
	return rows
}

// activityColumnsFor is the header that matches activityRows' arity for a format.
func activityColumnsFor(outFmt string) []string {
	if outFmt == ui.FormatCSV {
		return activityCSVColumns
	}
	return activityColumns
}

// decisionLabel maps the PDP decision boolean to a human label.
func decisionLabel(allowed bool) string {
	if allowed {
		return "allow"
	}
	return "deny"
}

// runActivity fetches and renders the activity log (non-interactive path).
func runActivity(c apiClient, out io.Writer, outFmt string, limit int) error {
	entries, err := c.ListActivity(limit)
	if err != nil {
		return err
	}
	if len(entries) == 0 && outFmt == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No activity found."))
		return nil
	}
	return ui.Render(out, outFmt, ui.TableSpec{
		Columns: activityColumnsFor(outFmt),
		Rows:    activityRows(entries, outFmt),
	}, entries)
}

func init() {
	activityCmd.Flags().IntVarP(&activityLimit, "limit", "n", 50,
		mustGovField("alethia activity", fieldKeyGovLimit).Description)
	rootCmd.AddCommand(activityCmd)
}
