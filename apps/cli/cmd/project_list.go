// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var projectListColumns = []string{"Project", "Env", "Status", "Provider", "Region", "Cost", "Updated"}

// noProjectsNote is what an empty project list says: there is nothing here, and these are the two
// ways to make one.
const noProjectsNote = "No projects yet. Create one with `alethia up` (from nothing to a running project) or `alethia project create`."

var listProjectsCmd = &cobra.Command{
	Use:   "list",
	Short: "List the projects in the active organization",
	Long: `List every project in the active organization, with its stage, status, cloud, region and estimated monthly cost.

Use it to find a project's name before another command, or to see what exists. On a terminal the
list is a table you can move through; with --output json or csv, or when piped, it is the plain
records.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runProjectList(cmd); err != nil {
			fail(err)
		}
	},
}

// runProjectList fetches the projects and shows them: the interactive table on a terminal, the
// rendered records otherwise.
func runProjectList(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}

	var configs []types.ConfigurationSummary
	runSpinner("Fetching projects...", func() {
		configs, err = api.NewClient(token).GetConfigurations()
	})
	if err != nil {
		return fmt.Errorf("failed to fetch projects: %w", err)
	}

	if interactiveTable(cmd) && len(configs) > 0 {
		// ui.ShowTable, like every other list in the CLI: it measures the columns to their
		// contents, truncates at the shared MaxColWidth, and sorts by the first column's title.
		err := ui.ShowTable(projectListColumns, projectRows(configs, ui.FormatTable), "projects")
		if err != nil {
			err = fmt.Errorf("show the project table: %w", err)
		}
		return err
	}
	format := outputFormat(cmd)
	// An empty list has no result to put on stdout: the empty state is said on stderr.
	if len(configs) == 0 && emptyListNote(printer, format, noProjectsNote) {
		return nil
	}
	return renderProjects(printer.Out, format, configs)
}

// projectRows projects each configuration summary into a plain table row.
// wireTime renders an instant for a machine: RFC3339 in UTC, and empty for the zero time,
// which is the absence a reader sees as the dash.
func wireTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func projectRows(configs []types.ConfigurationSummary, outFmt string) [][]string {
	rows := make([][]string, len(configs))
	for i, v := range configs {
		// The wire value is what a script matches on, so the machine arm keeps the provider's
		// CASE. `strings.ToUpper` is a display decision — a script grepping for `aws`, the value
		// every other surface uses, would otherwise have to know this one column shouts.
		provider := ui.Cell(outFmt, string(v.CloudProvider), ui.OrDash(strings.ToUpper(string(v.CloudProvider))))
		region := ui.Cell(outFmt, v.Region, ui.OrDash(v.Region))
		// DRAFT is an inference for a READER: the wire sent no status, and a blank cell in a
		// status column reads as a rendering bug rather than as a project nobody has applied yet.
		// A script is told what arrived — empty — because handing it a status the server never
		// sent is the one thing a machine format must not do.
		humanStatus := string(v.Status)
		if humanStatus == "" {
			humanStatus = "DRAFT"
		}
		status := ui.Cell(outFmt, string(v.Status), ui.StatusCell(humanStatus))
		// A machine gets the bare number and an empty field for "unpriced"; a reader gets the
		// rendered rate and the dash. Same split, and the same reason, as cost.go's Monthly cell.
		cost := ui.Cell(outFmt, "", ui.SymbolDash)
		if v.EstimatedMonthlyCost != nil {
			// `$%.0f/mo` was the live half-to-even defect: Go's %f rounds half to EVEN, so an
			// estimate of 12.5 printed `$12/mo` against a billing page showing `$12.50`. Estimate
			// keeps the minor units above one unit, so the cell now reads `$12.50/mo`.
			//
			// USD is ASSUMED, as the `$` glyph before it was: `types.ConfigurationSummary` carries no
			// currency at all, so a euro org is shown a dollar sign. That is a WIRE gap, not a
			// rendering one — `cost show` gets this right because its response carries `Currency` —
			// and it is visible here rather than hidden inside a format string.
			cost = ui.Cell(outFmt,
				strconv.FormatFloat(*v.EstimatedMonthlyCost, 'f', 2, 64),
				format.MonthlyRate(*v.EstimatedMonthlyCost, format.Estimate, "USD"))
		}
		rows[i] = []string{
			v.ProjectName,
			string(v.EnvironmentStage),
			status,
			provider,
			region,
			cost,
			// Updated already parsed and SORTED for a script — SmartTime's absolute arm was
			// `2006-01-02` before #3659 moved it to `9 Mar 2026`. RFC3339 keeps both properties.
			ui.Cell(outFmt, wireTime(v.UpdatedAt), ui.SmartTime(v.UpdatedAt)),
		}
	}
	return rows
}

// renderProjects writes the project list to out in the requested format. Handed an empty list in
// the table format it writes the empty state itself, for a caller that has one writer; the command
// says it on stderr before it gets here.
func renderProjects(out io.Writer, format string, configs []types.ConfigurationSummary) error {
	if len(configs) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(noProjectsNote))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: projectListColumns,
		Rows:    projectRows(configs, format),
	}, configs)
}

// emptyListNote writes the empty state of a list on stderr, for the table format only: json and
// csv say "nothing" with an empty document, and a sentence in one would break its parser.
func emptyListNote(p *Printer, format, note string) bool {
	if format != ui.FormatTable {
		return false
	}
	p.Note(note)
	return true
}

func init() {
	projectCmd.AddCommand(listProjectsCmd)
}
