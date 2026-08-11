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
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/spf13/cobra"
)

var verifyShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the per-control verification report behind a job's verdict",
	Long: `Prints the elench report the receipt seals: every control that was evaluated, its
status, and the findings behind a failure.

Controls that report ` + "`not_evaluable`" + ` are shown, not hidden. A control the engine could
not inspect is not a control that passed, and a report that quietly omitted them would overstate
what was checked. Any recorded waiver is printed with who granted it and why.

Exits non-zero on a blocking verdict, matching elench-verify, so this can gate a pipeline on the
verification result the way ` + "`alethia verify receipt`" + ` gates on the signature.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		jobID, err := currentJob(cmd)
		if err != nil {
			fail(err)
		}
		if err := runVerifyShow(api.NewClient(token), os.Stdout, outputFormat(cmd), jobID); err != nil {
			fail(err)
		}
	},
}

var verifyControlColumns = []string{"Control", "Status", "Severity", "Title"}

// verifyControlRows projects the per-control results into table cells.
func verifyControlRows(controls []verify.ControlResult) [][]string {
	rows := make([][]string, len(controls))
	for i, c := range controls {
		rows[i] = []string{c.ID, string(c.Status), string(c.Severity), c.Title}
	}
	return rows
}

// verifyReportSummary renders the one-line headline above the control table.
func verifyReportSummary(r *verify.Report) string {
	head := fmt.Sprintf("Verify: %s (%s, catalog %s) — %d pass, %d fail, %d warn, %d not evaluable",
		r.Verdict, r.Provider, r.CatalogVersion,
		r.Summary.Pass, r.Summary.Fail, r.Summary.Warn, r.Summary.NotEvaluable)
	if r.Blocking() {
		return ui.FormatError(head)
	}
	if r.Summary.Fail > 0 || r.Summary.Warn > 0 || r.Summary.NotEvaluable > 0 {
		return ui.WarningStyle.Render(head)
	}
	return ui.FormatSuccess(head)
}

// writeFindings prints the findings behind every non-passing control, and the waiver if one was
// recorded. Findings are what make a failure actionable; a bare status column would say a control
// failed without saying which resource caused it.
func writeFindings(out io.Writer, r *verify.Report, ex *verify.RecordedException) {
	for _, c := range r.Controls {
		if len(c.Findings) == 0 && c.Coverage == "" {
			continue
		}
		if c.Status == verify.StatusPass {
			continue
		}
		fmt.Fprintf(out, "\n%s %s — %s\n", ui.SymbolPoint, c.ID, c.Title)
		for _, f := range c.Findings {
			fmt.Fprintf(out, "    %s: %s\n", f.Address, f.Message)
		}
		if c.Coverage != "" {
			fmt.Fprintf(out, "    %s\n", ui.MutedStyle.Render("coverage: "+c.Coverage))
		}
	}
	if ex != nil {
		fmt.Fprintf(out, "\n%s\n", ui.WarningStyle.Render(fmt.Sprintf(
			"Waiver: %s — granted by %s, reason: %s", strings.Join(ex.Controls, ", "), ex.By, ex.Reason)))
		if ex.Expiry != "" {
			fmt.Fprintf(out, "    %s\n", ui.MutedStyle.Render("expires "+ex.Expiry))
		}
	}
}

// runVerifyShow fetches a job's receipt and renders the report it seals. json emits the whole
// report; table prints the headline, the control table and the findings; csv emits control rows.
// Returns a non-nil error on a blocking verdict so the exit status carries the result.
func runVerifyShow(c apiClient, out io.Writer, format, jobID string) error {
	job, err := c.GetJob(jobID)
	if err != nil {
		return err
	}
	sr, err := receiptFromJob(job)
	if err != nil {
		return err
	}
	report := sr.Receipt.Report
	if report == nil {
		return fmt.Errorf("this job's receipt carries no verification report")
	}

	if format == ui.FormatJSON {
		if err := ui.Render(out, format, ui.TableSpec{}, report); err != nil {
			return err
		}
		return blockingErr(report)
	}
	if format == ui.FormatTable {
		fmt.Fprintln(out, verifyReportSummary(report))
		fmt.Fprintln(out)
	}
	if err := ui.Render(out, format, ui.TableSpec{
		Columns: verifyControlColumns,
		Rows:    verifyControlRows(report.Controls),
	}, report.Controls); err != nil {
		return err
	}
	if format == ui.FormatTable {
		writeFindings(out, report, sr.Receipt.Exception)
	}
	return blockingErr(report)
}

// blockingErr turns a blocking verdict into the error that sets a non-zero exit.
func blockingErr(r *verify.Report) error {
	if r.Blocking() {
		return fmt.Errorf("verification verdict is %s — %d control(s) failed", r.Verdict, r.Summary.Fail)
	}
	return nil
}
