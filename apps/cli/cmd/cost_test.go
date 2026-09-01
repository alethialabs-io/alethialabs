// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

func f64(v float64) *float64 { return &v }

func TestRunCostShowPriced(t *testing.T) {
	ts := "2026-01-01T00:00:00.000Z"
	c := &fakeClient{cost: &api.EnvironmentCost{
		Priced: true, TotalMonthly: f64(123.45), Currency: "USD", CapturedAt: &ts, Environment: strptr("staging"),
		Resources: []api.CostResourceLine{
			{Address: "aws_db_instance.main", ResourceType: "aws_db_instance", MonthlyCost: 100.00},
			{Address: "aws_s3_bucket.logs", ResourceType: "aws_s3_bucket", MonthlyCost: 23.45},
		},
	}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", "staging"); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"$123.45/mo", "staging", "aws_db_instance.main", "$100.00/mo", "$23.45/mo"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
	// The ISO code is NOT printed beside a symbol it already implies. `$123.45/mo USD` was the old
	// shape, and it is the readable half of the defect that made `€` amounts read as dollars.
	if strings.Contains(out, "USD") {
		t.Errorf("headline still carries the ISO code beside the symbol:\n%s", out)
	}
}

// --- money: the currency is the ENVIRONMENT's, not the format string's ---

// TestCostSummaryRendersTheEnvironmentsOwnCurrency is the defect the issue names by line number.
// `fmt.Sprintf("Cost%s: $%.2f/mo %s%s", …)` welded a `$` to the amount and appended the wire's ISO
// code, so a euro organization was told two currencies about one number and the leading one was
// always wrong.
func TestCostSummaryRendersTheEnvironmentsOwnCurrency(t *testing.T) {
	got := costSummary(&api.EnvironmentCost{Priced: true, TotalMonthly: f64(12), Currency: "EUR"})
	if !strings.Contains(got, "€12.00/mo") {
		t.Errorf("EUR headline = %q, want it to carry €12.00/mo", got)
	}
	if strings.Contains(got, "$") {
		t.Errorf("EUR headline still prints a dollar sign: %q", got)
	}
	if strings.Contains(got, "EUR") {
		t.Errorf("EUR headline names the currency twice (symbol and ISO code): %q", got)
	}
}

// TestCostSummaryNamesACurrencyItHasNoSymbolFor pins the other half of the same rule: a currency
// with no narrow symbol renders its ISO code and NEVER a guessed glyph. A guessed symbol on a
// billed amount is the worst answer available.
func TestCostSummaryNamesACurrencyItHasNoSymbolFor(t *testing.T) {
	got := costSummary(&api.EnvironmentCost{Priced: true, TotalMonthly: f64(12.5), Currency: "HUF"})
	if !strings.Contains(got, "12.50 HUF/mo") {
		t.Errorf("HUF headline = %q, want it to carry 12.50 HUF/mo", got)
	}
	if strings.Contains(got, "$") || strings.Contains(got, "€") {
		t.Errorf("HUF headline invented a symbol: %q", got)
	}
}

// TestCostMoneyRoundsTheWayTheConsoleDoes drives BOTH sides of the rounding claim rather than
// asserting the fixed output alone.
//
// The premise — that Go's %f rounds half to EVEN and so disagrees with the billing page — is
// measured here, not remembered: if a future Go changed it, the first assertion fails and says so,
// instead of this test quietly becoming a tautology about a defect that no longer exists.
//
// 0.125 is the case at TWO decimals. It is exactly representable in binary, so nothing here rests
// on float noise: %.2f gives 0.12 and JavaScript's toFixed(2) gives 0.13.
func TestCostMoneyRoundsTheWayTheConsoleDoes(t *testing.T) {
	if got := fmt.Sprintf("$%.2f", 0.125); got != "$0.12" {
		t.Fatalf(`premise broken: fmt.Sprintf("$%%.2f", 0.125) = %q, want "$0.12" — this test exists `+
			"because Go rounds half to EVEN there and the console does not", got)
	}
	rows := costRows([]api.CostResourceLine{{Address: "a", ResourceType: "t", MonthlyCost: 0.125}}, "USD")
	if got := rows[0][2]; got != "$0.13/mo" {
		t.Errorf("cost cell for 0.125 = %q, want $0.13/mo — the console shows $0.13", got)
	}
}

// TestCostRowsRenderInTheEnvironmentsCurrency covers the per-resource half. costRows took no
// currency at all before, which is why every row was in dollars whatever the environment was
// priced in.
func TestCostRowsRenderInTheEnvironmentsCurrency(t *testing.T) {
	rows := costRows([]api.CostResourceLine{
		{Address: "aws_db_instance.main", ResourceType: "aws_db_instance", MonthlyCost: 100},
	}, "EUR")
	if got := rows[0][2]; got != "€100.00/mo" {
		t.Errorf("EUR row cell = %q, want €100.00/mo", got)
	}
}

// TestCostRowsAndHeadlineUseOneRule is the agreement the issue is really about: a headline and the
// column beneath it that round differently make the column not add up to the headline.
func TestCostRowsAndHeadlineUseOneRule(t *testing.T) {
	line := api.CostResourceLine{Address: "a", ResourceType: "t", MonthlyCost: 0.125}
	cost := &api.EnvironmentCost{Priced: true, TotalMonthly: f64(0.125), Currency: "USD", Resources: []api.CostResourceLine{line}}
	cell := costRows(cost.Resources, cost.Currency)[0][2]
	if !strings.Contains(costSummary(cost), cell) {
		t.Errorf("headline %q does not render the same amount as the row cell %q", costSummary(cost), cell)
	}
}

func TestRunCostShowEmptyResourcesStillPrintsTheHeadline(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: true, TotalMonthly: f64(7.5), Currency: "GBP"}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	if !strings.Contains(buf.String(), "£7.50/mo") {
		t.Errorf("expected the GBP headline with no resource table, got: %q", buf.String())
	}
}

// --- the capture stamp ---

func TestCostSummaryRendersTheCaptureStampLikeTheConsole(t *testing.T) {
	ts := "2026-03-09T15:04:05.000Z"
	got := costSummary(&api.EnvironmentCost{Priced: true, TotalMonthly: f64(1), Currency: "USD", CapturedAt: &ts})
	if !strings.Contains(got, "(captured 9 Mar 2026, 15:04)") {
		t.Errorf("headline = %q, want the console's date shape", got)
	}
	if strings.Contains(got, ts) {
		t.Errorf("headline still echoes the raw wire timestamp: %q", got)
	}
}

// TestCostCapturedAtKeepsAnUnparseableStampVerbatim: a timestamp the CLI cannot read is a WIRE
// problem, and showing it lets someone report what actually arrived. A dash would hide it.
func TestCostCapturedAtKeepsAnUnparseableStampVerbatim(t *testing.T) {
	if got := costCapturedAt("last tuesday"); got != "last tuesday" {
		t.Errorf("costCapturedAt(unparseable) = %q, want it returned verbatim", got)
	}
}

// TestCostCapturedAtIsTheSameInstantEverywhere: the stamp is rendered in UTC and not in the
// process's zone, so two engineers reading the same cost record read the same time.
func TestCostCapturedAtIsTheSameInstantEverywhere(t *testing.T) {
	if got := costCapturedAt("2026-03-09T23:30:00+09:00"); got != "9 Mar 2026, 14:30" {
		t.Errorf("costCapturedAt(+09:00 stamp) = %q, want it normalised to UTC (9 Mar 2026, 14:30)", got)
	}
}

// --- resolving the project: flag first, picker second, --no-input names the flag ---

func newCostTestCmd() *cobra.Command {
	c := &cobra.Command{Use: "show"}
	c.Flags().StringP("project", "p", "", "")
	return c
}

func TestResolveCostProjectPrefersTheFlag(t *testing.T) {
	c := newCostTestCmd()
	if err := c.ParseFlags([]string{"--project", "web"}); err != nil {
		t.Fatalf("parse flags: %v", err)
	}
	picked := false
	got, err := resolveCostProject(c, func() (string, error) { picked = true; return "other", nil })
	if err != nil || got != "web" {
		t.Fatalf("resolveCostProject = %q, %v; want web", got, err)
	}
	if picked {
		t.Error("the picker ran even though --project answered the question — the flag is the whole contract")
	}
}

func TestResolveCostProjectFallsBackToThePicker(t *testing.T) {
	got, err := resolveCostProject(newCostTestCmd(), func() (string, error) { return "picked-id", nil })
	if err != nil || got != "picked-id" {
		t.Fatalf("resolveCostProject = %q, %v; want picked-id", got, err)
	}
}

// TestResolveCostProjectUnderNoInputNamesTheFlag: errNoInput says "interactive input required",
// which is true and useless in a script. The refusal must name the flag that would have answered it.
func TestResolveCostProjectUnderNoInputNamesTheFlag(t *testing.T) {
	_, err := resolveCostProject(newCostTestCmd(), func() (string, error) { return "", errNoInput })
	if err == nil {
		t.Fatal("expected a refusal under --no-input")
	}
	if !strings.Contains(err.Error(), "--project") {
		t.Errorf("refusal = %q, want it to name --project", err)
	}
}

// TestResolveCostProjectSurfacesARealPickerFailure: a network failure fetching the project list is
// not a missing flag, and rewriting it as one would send the reader to fix the wrong thing.
func TestResolveCostProjectSurfacesARealPickerFailure(t *testing.T) {
	boom := errors.New("failed to fetch projects: connection refused")
	_, err := resolveCostProject(newCostTestCmd(), func() (string, error) { return "", boom })
	if !errors.Is(err, boom) {
		t.Errorf("resolveCostProject swallowed the picker's error: %v", err)
	}
}

// TestResolveCostProjectRefusesAnEmptySelection: a picker that returns "" with no error would
// otherwise send an empty project to the API and get back a 404 naming nothing the user typed.
func TestResolveCostProjectRefusesAnEmptySelection(t *testing.T) {
	_, err := resolveCostProject(newCostTestCmd(), func() (string, error) { return "", nil })
	if err == nil || !strings.Contains(err.Error(), "--project") {
		t.Errorf("empty selection = %v, want a refusal naming --project", err)
	}
}

func TestRunCostShowUnpriced(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: false, Currency: "USD"}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	if !strings.Contains(buf.String(), "not priced") {
		t.Errorf("expected not-priced summary, got: %q", buf.String())
	}
}

func TestRunCostShowJSON(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: true, TotalMonthly: f64(10), Currency: "USD", Resources: []api.CostResourceLine{{Address: "a", ResourceType: "t", MonthlyCost: 10}}}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runCostShow json: %v", err)
	}
	if !strings.Contains(buf.String(), `"priced": true`) || !strings.Contains(buf.String(), `"resource_type": "t"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunCostShowError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runCostShow(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}
