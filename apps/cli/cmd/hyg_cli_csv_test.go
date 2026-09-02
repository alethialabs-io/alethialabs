// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The three tables #3659 would otherwise have broken for scripts.
//
// `ui.Render`'s CSV branch writes `spec.Rows` verbatim, so whatever a row builder makes for a
// person is also what `-o csv` emits. Humanising a cell is therefore a WIRE CHANGE for anything
// already parsing it, and these three were already parseable: `promotion list` emitted the wire's
// RFC3339, `token list` emitted `2026-08-26 09:41` (which sorts lexically), and `project list`'s
// Updated emitted `2006-01-02` (which sorts AND parses).
//
// This pins the floor #3659 owes — DO NOT REGRESS A CELL THAT PARSED — not the whole CSV defect,
// which is #4033's: the dash glyph, the gate ticks, the status glyph and the truncated id were
// never machine-readable and are decided there, together.
//
// The assertion is deliberately about PARSING, not about equality with some expected string. A test
// that compared the cell to `ui.Wire(...)` would pass just as happily if both sides moved to the
// same wrong thing, which is the failure mode the human/machine split exists to prevent.

const csvProbeStamp = "2026-03-09T15:04:05Z"

// mustParseCell fails unless the cell is an RFC3339 instant — the machine form.
func mustParseCell(t *testing.T, table, column, got string) {
	t.Helper()
	if got == "" {
		t.Fatalf("%s -o csv: %s is empty, want an RFC3339 instant", table, column)
	}
	if _, err := time.Parse(time.RFC3339, got); err != nil {
		t.Errorf("%s -o csv: %s = %q, which does not parse as RFC3339 (%v).\n"+
			"      The CSV branch writes rows verbatim, so humanising this cell changes what every\n"+
			"      script reading it receives. Render the human form only when outFmt is not CSV.",
			table, column, got, err)
	}
	// A comma is worse than an unparseable value: encoding/csv quotes the field correctly, so the
	// file stays RFC-4180 valid, but every `cut -d,` and `awk -F,` consumer shifts a column from
	// there on. `9 Mar 2026, 15:04` is exactly that shape.
	if strings.Contains(got, ",") {
		t.Errorf("%s -o csv: %s = %q contains a comma — it forces quoting and shifts naive readers",
			table, column, got)
	}
}

func TestHygCliCsv_PromotionKeepsTheWireStamp(t *testing.T) {
	decided := csvProbeStamp
	rows := promotionListRows([]api.Promotion{{
		ID: "p-1", Source: "staging", Target: "production", Status: "PENDING", CreatedAt: csvProbeStamp,
	}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "promotion list", "Created", rows[0][4])

	appr := approvalRows([]api.PromotionApproval{{Status: "APPROVED", DecidedAt: &decided}}, ui.FormatCSV)
	if len(appr) != 1 {
		t.Fatalf("want 1 approval row, got %d", len(appr))
	}
	mustParseCell(t, "promotion get", "Decided", appr[0][3])

	// An ABSENT decision is empty for a machine, never the em dash a reader gets.
	none := approvalRows([]api.PromotionApproval{{Status: "PENDING"}}, ui.FormatCSV)
	if got := none[0][3]; got != "" {
		t.Errorf("promotion get -o csv: an undecided slot = %q, want an empty field", got)
	}
}

func TestHygCliCsv_TokenKeepsTheWireStamps(t *testing.T) {
	expires := csvProbeStamp
	rows := tokenRows([]api.ServiceToken{{
		ID: "id-1", Name: "ci", TokenPrefix: "alethia_sat_abc12345",
		CreatedAt: csvProbeStamp, ExpiresAt: &expires,
	}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "token list", "Created", rows[0][3])
	mustParseCell(t, "token list", "Expires", rows[0][4])

	// "never" is a WORD, and a reader wants it. A machine wants the absence.
	if got := rows[0][5]; got != "" {
		t.Errorf("token list -o csv: an unused token's Last used = %q, want an empty field", got)
	}
}

func TestHygCliCsv_ProjectListKeepsASortableUpdated(t *testing.T) {
	updated, err := time.Parse(time.RFC3339, csvProbeStamp)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	rows := projectRows([]types.ConfigurationSummary{{ProjectName: "web", UpdatedAt: updated}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "project list", "Updated", rows[0][6])
}

func TestHygCliCsv_JobsListKeepsASortableCreated(t *testing.T) {
	created, err := time.Parse(time.RFC3339, csvProbeStamp)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	rows := jobRowsPlain([]api.ProvisionJob{{JobType: "PLAN", Status: "QUEUED", CreatedAt: created}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "jobs list", "Created", rows[0][4])
}

// The same builders must still humanise for a person — otherwise "does not regress CSV" could be
// satisfied by never humanising at all, which would silently undo the change these tests sit beside.
func TestHygCliCsv_TheTableFormStillReadsForAPerson(t *testing.T) {
	const want = "9 Mar 2026, 15:04"
	rows := promotionListRows([]api.Promotion{{ID: "p-1", CreatedAt: csvProbeStamp}}, ui.FormatTable)
	if got := rows[0][4]; got != want {
		t.Errorf("promotion list -o table: Created = %q, want %q", got, want)
	}
	tok := tokenRows([]api.ServiceToken{{ID: "id-1", CreatedAt: csvProbeStamp}}, ui.FormatTable)
	if got := tok[0][3]; got != want {
		t.Errorf("token list -o table: Created = %q, want %q", got, want)
	}
}
