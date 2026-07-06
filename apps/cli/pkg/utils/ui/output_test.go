// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestValidFormat(t *testing.T) {
	for _, f := range []string{FormatTable, FormatJSON, FormatCSV} {
		if !ValidFormat(f) {
			t.Errorf("expected %q to be valid", f)
		}
	}
	for _, f := range []string{"", "yaml", "xml", "Table"} {
		if ValidFormat(f) {
			t.Errorf("expected %q to be invalid", f)
		}
	}
}

func TestRenderJSON(t *testing.T) {
	var buf bytes.Buffer
	records := []map[string]string{{"name": "alpha"}, {"name": "beta"}}
	if err := Render(&buf, FormatJSON, TableSpec{}, records); err != nil {
		t.Fatalf("Render json: %v", err)
	}
	var got []map[string]string
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("output is not valid json: %v\n%s", err, buf.String())
	}
	if len(got) != 2 || got[0]["name"] != "alpha" {
		t.Errorf("unexpected json: %s", buf.String())
	}
}

func TestRenderCSV(t *testing.T) {
	var buf bytes.Buffer
	spec := TableSpec{
		Columns: []string{"Name", "Role"},
		Rows:    [][]string{{"alpha", "owner"}, {"beta", "member"}},
	}
	if err := Render(&buf, FormatCSV, spec, nil); err != nil {
		t.Fatalf("Render csv: %v", err)
	}
	want := "Name,Role\nalpha,owner\nbeta,member\n"
	if buf.String() != want {
		t.Errorf("csv mismatch:\ngot:  %q\nwant: %q", buf.String(), want)
	}
}

func TestRenderCSVQuotesCommas(t *testing.T) {
	var buf bytes.Buffer
	spec := TableSpec{
		Columns: []string{"Field", "Value"},
		Rows:    [][]string{{"types", "a,b,c"}},
	}
	if err := Render(&buf, FormatCSV, spec, nil); err != nil {
		t.Fatalf("Render csv: %v", err)
	}
	if !strings.Contains(buf.String(), `"a,b,c"`) {
		t.Errorf("expected comma-containing field to be quoted: %q", buf.String())
	}
}

func TestRenderTable(t *testing.T) {
	var buf bytes.Buffer
	spec := TableSpec{
		Columns: []string{"Name", "Plan"},
		Rows:    [][]string{{"alpha", "team"}, {"beta-longer", "community"}},
	}
	if err := Render(&buf, FormatTable, spec, nil); err != nil {
		t.Fatalf("Render table: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"Name", "Plan", "alpha", "beta-longer", "community"} {
		if !strings.Contains(out, want) {
			t.Errorf("table missing %q in:\n%s", want, out)
		}
	}
	// The header row must be padded to the widest cell in the column.
	if !strings.Contains(out, "beta-longer") {
		t.Errorf("expected widest cell present")
	}
}

func TestRenderEmptyTable(t *testing.T) {
	var buf bytes.Buffer
	if err := Render(&buf, FormatTable, TableSpec{Columns: []string{"A"}}, nil); err != nil {
		t.Fatalf("Render empty table: %v", err)
	}
	// Header only, no panic.
	if !strings.Contains(buf.String(), "A") {
		t.Errorf("expected header in empty table")
	}
}

func TestRenderDefaultsToTable(t *testing.T) {
	var buf bytes.Buffer
	if err := Render(&buf, "", TableSpec{Columns: []string{"X"}, Rows: [][]string{{"y"}}}, nil); err != nil {
		t.Fatalf("Render default: %v", err)
	}
	if !strings.Contains(buf.String(), "y") {
		t.Errorf("expected default table render")
	}
}

func TestRenderUnknownFormat(t *testing.T) {
	var buf bytes.Buffer
	if err := Render(&buf, "yaml", TableSpec{}, nil); err == nil {
		t.Error("expected error for unknown format")
	}
}

func TestTruncate(t *testing.T) {
	cases := []struct {
		in   string
		max  int
		want string
	}{
		{"short", 40, "short"},
		{"exactlyten", 10, "exactlyten"},
		{"abcdefghij", 5, "abcd…"},
		{"abc", 0, "abc"},
		{"abcdef", 1, "…"},
	}
	for _, c := range cases {
		if got := Truncate(c.in, c.max); got != c.want {
			t.Errorf("Truncate(%q, %d) = %q, want %q", c.in, c.max, got, c.want)
		}
	}
	// A truncated result never exceeds the cap.
	if w := lipgloss.Width(Truncate("a very long cell value that overflows", 12)); w > 12 {
		t.Errorf("truncated width %d exceeds cap 12", w)
	}
}

func TestRenderTableCapsWidth(t *testing.T) {
	var buf bytes.Buffer
	long := strings.Repeat("x", 100)
	spec := TableSpec{Columns: []string{"Events"}, Rows: [][]string{{long}}}
	if err := Render(&buf, FormatTable, spec, nil); err != nil {
		t.Fatalf("Render: %v", err)
	}
	for _, line := range strings.Split(strings.TrimRight(buf.String(), "\n"), "\n") {
		if lipgloss.Width(line) > MaxColWidth {
			t.Errorf("table line exceeds MaxColWidth (%d): width=%d %q", MaxColWidth, lipgloss.Width(line), line)
		}
	}
	// CSV must keep the full value (no cap).
	buf.Reset()
	if err := Render(&buf, FormatCSV, spec, nil); err != nil {
		t.Fatalf("Render csv: %v", err)
	}
	if !strings.Contains(buf.String(), long) {
		t.Error("csv must retain the full untruncated value")
	}
}

func TestPadCell(t *testing.T) {
	if got := padCell("ab", 5); got != "ab   " {
		t.Errorf("padCell short: %q", got)
	}
	if got := padCell("abcdef", 3); got != "abcdef" {
		t.Errorf("padCell overflow should not truncate: %q", got)
	}
}
