// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var activityLimit int

var activityCmd = &cobra.Command{
	Use:   "activity",
	Short: "Show the organization's activity log",
	Args:  cobra.NoArgs,
	Long: `Reads the active organization's activity log, newest first: every recorded action and every
denial, with who did it, what it touched and — for a denial — why. Alert deliveries are in it too.

Use it to answer "who changed this?" or "why was I refused?". It prints at once; -n/--limit sets
how many entries are read (50 when omitted). On a terminal, when the page came back full, you are
offered more rows after the table.

--output json prints the entries as an array, and --output csv the wire values, with the resource
type and its id in two columns.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runActivityCmd(cmd); err != nil {
			fail(err)
		}
	},
}

// runActivityCmd is `activity` from the command line to the printed log. It asks nothing before
// printing: the limit has a default, and a question in front of the answer was a step between the
// person and what they came for.
func runActivityCmd(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	client := api.NewClient(token)
	if !interactiveTable(cmd) {
		if err := runActivity(client, p.Out, p.Format, activityLimit); err != nil {
			return fmt.Errorf("read activity: %w", err)
		}
		return nil
	}
	limit := activityLimit
	for {
		var entries []api.ActivityEntry
		runSpinner("Fetching activity...", func() { entries, err = client.ListActivity(limit) })
		if err != nil {
			return fmt.Errorf("read activity: %w", err)
		}
		if len(entries) == 0 {
			fmt.Fprintln(p.Out, ui.MutedStyle.Render("No activity found."))
			return nil
		}
		_ = ui.ShowTable(activityColumns, activityRows(entries, ui.FormatTable), "activity")
		next, err := offerMoreActivity(limit, len(entries))
		if err != nil || next == 0 {
			return err
		}
		limit = next
	}
}

// activityRowLadder is what the "more rows?" question offers after a full page.
//
// A ladder rather than a typed number, because every answer to "how many rows" is a round one and a
// select cannot be answered with a value the route refuses. It is deliberately NOT a validation
// set: `-n 137` still reaches the server, which is the only side that knows what it will serve.
var activityRowLadder = []int{25, 50, 100, 200, 500}

// offerMoreActivity asks, AFTER the table, whether to read more rows, and returns the new limit — or
// 0 when the person is done, the page was not full (there is nothing more to read), or nobody can be
// asked.
//
// After and never before: the question used to stand between the person and the log, asking how
// many rows they wanted before they had seen one. A page that came back short is the whole log, so
// no question is put at all.
func offerMoreActivity(limit, got int) (int, error) {
	if got < limit || !canPromptForm() {
		return 0, nil
	}
	f := mustGovField("alethia activity", fieldKeyGovLimit)
	options := []huh.Option[int]{huh.NewOption("Done", 0)}
	for _, n := range activityRowsAbove(limit) {
		options = append(options, huh.NewOption(fmt.Sprintf("Show %d rows", n), n))
	}
	if len(options) == 1 {
		return 0, nil
	}
	chosen := 0
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title("More activity?").Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return 0, err
	}
	return chosen, nil
}

// activityRowsAbove is the ladder's rungs larger than the current limit, ascending.
func activityRowsAbove(limit int) []int {
	above := make([]int, 0, len(activityRowLadder))
	for _, n := range activityRowLadder {
		if n > limit {
			above = append(above, n)
		}
	}
	return above
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
