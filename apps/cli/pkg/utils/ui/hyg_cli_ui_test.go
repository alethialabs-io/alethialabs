// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"errors"
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/lipgloss"
)

// hygCLIUIFailAfter is an io.Writer that succeeds for the first `ok` writes and
// fails afterwards, so the header write and the row write of the static table
// can each be failed independently.
type hygCLIUIFailAfter struct {
	ok int
	n  int
}

// Write counts the call and fails once the allowance is spent.
func (w *hygCLIUIFailAfter) Write(p []byte) (int, error) {
	w.n++
	if w.n > w.ok {
		return 0, errors.New("disk full")
	}
	return len(p), nil
}

// TestHygCLIUIStyledTableHeaderAlignsWithCells pins #2052: the header row of a
// styled table must occupy exactly the same display columns as its data rows.
func TestHygCLIUIStyledTableHeaderAlignsWithCells(t *testing.T) {
	cols := []table.Column{
		{Title: "Project", Width: 10},
		{Title: "Status", Width: 10},
		{Title: "Region", Width: 10},
	}
	rows := []table.Row{{"alpha", "ONLINE", "eu-central"}}

	view := NewStyledTable(cols, rows).View()
	lines := strings.Split(view, "\n")
	if len(lines) < 3 {
		t.Fatalf("unexpected table view:\n%s", view)
	}
	header, data := lines[0], lines[len(lines)-1]

	if hw, dw := lipgloss.Width(header), lipgloss.Width(data); hw != dw {
		t.Errorf("header row width %d != data row width %d — the header is misaligned with its columns\nheader: %q\ndata:   %q\nfull view:\n%s",
			hw, dw, header, data, view)
	}
	// The first data cell starts one column in (Cell padding); the first header
	// cell must start at the same offset, and so must the last one.
	if got, want := strings.Index(data, "alpha"), strings.Index(header, "Project"); got != want {
		t.Errorf("column 0 starts at %d in the data row but %d in the header row", got, want)
	}
	if got, want := strings.Index(data, "eu-central"), strings.Index(header, "Region"); got != want {
		t.Errorf("last column starts at %d in the data row but %d in the header row", got, want)
	}
	// The header underline rule must span the whole table body.
	if rule := lines[1]; lipgloss.Width(rule) != lipgloss.Width(data) {
		t.Errorf("header rule width %d != data row width %d", lipgloss.Width(rule), lipgloss.Width(data))
	}
}

// TestHygCLIUIStyledTableSelectedRowKeepsCellPadding guards the sibling of
// #2052: `s.Selected` is applied to the already-padded joined row, so replacing
// it wholesale (it carries no padding of its own) must not shift the cursor row.
func TestHygCLIUIStyledTableSelectedRowKeepsCellPadding(t *testing.T) {
	cols := []table.Column{{Title: "Project", Width: 10}}
	rows := []table.Row{{"alpha"}, {"beta"}}

	view := NewStyledTable(cols, rows).View()
	lines := strings.Split(view, "\n")
	if len(lines) < 4 {
		t.Fatalf("unexpected table view:\n%s", view)
	}
	// Line 0 is the header, line 1 the rule, line 2 the selected (cursor) row,
	// line 3 an unselected row. Both rows must measure the same.
	selected, plain := lines[2], lines[3]
	if sw, pw := lipgloss.Width(selected), lipgloss.Width(plain); sw != pw {
		t.Errorf("selected row width %d != unselected row width %d\n%s", sw, pw, view)
	}
}

// TestHygCLIUIStaticTableEmitsOneLinePerRow pins #2053: a cell carrying a
// newline must not forge an extra physical line in the static table, which is
// the default --output and the format piped into scripts and CI.
func TestHygCLIUIStaticTableEmitsOneLinePerRow(t *testing.T) {
	multiline := "dial tcp 10.0.0.1:443: i/o timeout\n  x509: bad certificate"
	// Precondition: the value really carries a line break, and lipgloss measures
	// only its widest line — 33 columns here, under MaxColWidth — so Truncate is
	// a no-op and the whole two-line value used to reach the writer intact.
	if !strings.Contains(multiline, "\n") {
		t.Fatal("precondition failed: the probe value carries no newline")
	}
	if lipgloss.Width(multiline) > MaxColWidth {
		t.Fatalf("precondition failed: lipgloss measured %d columns, expected the widest-line measurement to sit at or under MaxColWidth (%d)",
			lipgloss.Width(multiline), MaxColWidth)
	}
	if Truncate(multiline, MaxColWidth) != multiline {
		t.Fatal("precondition failed: Truncate already shortens the probe value, so it cannot demonstrate the newline leak")
	}

	spec := TableSpec{
		Columns: []string{"Environment", "Reachable", "Message"},
		Rows: [][]string{
			{"prod", "down", multiline},
			{"staging", "up", "-"},
		},
	}
	var buf strings.Builder
	if err := Render(&buf, FormatTable, spec, nil); err != nil {
		t.Fatalf("Render: %v", err)
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if want := 1 + len(spec.Rows); len(lines) != want {
		t.Fatalf("static table emitted %d lines, want %d (1 header + %d rows) — a newline in a cell forges an extra row\n%s",
			len(lines), want, len(spec.Rows), buf.String())
	}
	for i, row := range spec.Rows {
		if !strings.HasPrefix(lines[i+1], row[0]) {
			t.Errorf("line %d %q does not start with its first-column value %q", i+1, lines[i+1], row[0])
		}
	}
	// The head of the value must stay on the row line, and flattening the break
	// into a space makes the cell 57 columns wide, so MaxColWidth must now bite.
	if !strings.Contains(lines[1], "i/o timeout") {
		t.Errorf("row line %q lost the head of the multi-line value", lines[1])
	}
	if !strings.HasSuffix(lines[1], "…") {
		t.Errorf("row line %q was not capped to MaxColWidth after flattening", lines[1])
	}
}

// TestHygCLIUIStaticTableFlattensControlChars pins the rest of #2053: a header
// title and a cell carrying carriage returns, tabs or other cursor-moving
// control characters stay on one line and keep their neighbours' columns.
func TestHygCLIUIStaticTableFlattensControlChars(t *testing.T) {
	spec := TableSpec{
		Columns: []string{"Na\rme", "Note"},
		Rows:    [][]string{{"al\tpha", "one\vtwo\fthree\bfour"}},
	}
	var buf strings.Builder
	if err := Render(&buf, FormatTable, spec, nil); err != nil {
		t.Fatalf("Render: %v", err)
	}
	out := buf.String()
	if strings.ContainsAny(out, "\r\t\v\f\b") {
		t.Errorf("a cursor-moving control character survived into the rendered table: %q", out)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected a header plus one row, got %d lines:\n%s", len(lines), out)
	}
	if !strings.HasPrefix(lines[0], "Na me") {
		t.Errorf("header title was not flattened, got %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "al pha") {
		t.Errorf("cell was not flattened, got %q", lines[1])
	}
}

// TestHygCLIUIRenderTablePropagatesWriteErrors pins #2085: a failed write in the
// default `table` format must surface, exactly as it already does under
// --output csv, instead of exiting 0 having printed nothing.
func TestHygCLIUIRenderTablePropagatesWriteErrors(t *testing.T) {
	spec := TableSpec{
		Columns: []string{"Name", "Stage"},
		Rows:    [][]string{{"alpha", "prod"}, {"beta", "dev"}},
	}

	tests := []struct {
		name string
		ok   int
	}{
		{name: "header write fails", ok: 0},
		{name: "first row write fails", ok: 1},
		{name: "second row write fails", ok: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Precondition: the same spec renders cleanly to a healthy writer,
			// so a failure below can only come from the writer.
			var ok strings.Builder
			if err := Render(&ok, FormatTable, spec, nil); err != nil {
				t.Fatalf("precondition failed: Render to a healthy writer: %v", err)
			}
			w := &hygCLIUIFailAfter{ok: tt.ok}
			if err := Render(w, FormatTable, spec, nil); err == nil {
				t.Error("expected the underlying writer's error to propagate")
			}
			if w.n != tt.ok+1 {
				t.Errorf("Render kept writing after a failure: %d writes, want %d", w.n, tt.ok+1)
			}
		})
	}
}
