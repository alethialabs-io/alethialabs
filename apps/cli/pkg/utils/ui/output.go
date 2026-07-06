// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Output formats accepted by the global --output flag.
const (
	FormatTable = "table"
	FormatJSON  = "json"
	FormatCSV   = "csv"
)

// ValidFormat reports whether s is a supported --output value.
func ValidFormat(s string) bool {
	switch s {
	case FormatTable, FormatJSON, FormatCSV:
		return true
	default:
		return false
	}
}

// TableSpec is the columnar projection of a result set: header titles plus the
// matching plain-string cells per row (no ANSI — widths must compute correctly).
type TableSpec struct {
	Columns []string
	Rows    [][]string
}

var tableHeaderTextStyle = lipgloss.NewStyle().Foreground(InkMuted).Bold(true)

// Render writes a result set to out in the requested format. `table` renders a
// static grayscale table (pipe- and test-safe — unlike the interactive Bubble Tea
// tables used for TTY browsing); `json` marshals the typed records so consumers
// get whole objects, not just table cells; `csv` writes RFC-4180 rows. An empty
// format defaults to table; an unknown format is an error.
func Render(out io.Writer, format string, spec TableSpec, records any) error {
	switch format {
	case "", FormatTable:
		return renderStaticTable(out, spec)
	case FormatJSON:
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(records)
	case FormatCSV:
		w := csv.NewWriter(out)
		if len(spec.Columns) > 0 {
			if err := w.Write(spec.Columns); err != nil {
				return err
			}
		}
		for _, row := range spec.Rows {
			if err := w.Write(row); err != nil {
				return err
			}
		}
		w.Flush()
		return w.Error()
	default:
		return fmt.Errorf("unknown output format %q (want table, json, or csv)", format)
	}
}

// MaxColWidth bounds a table cell's displayed width so a long value (a joined
// list, a long name) can't blow the table past the terminal. Display-only —
// json/csv keep the full value.
const MaxColWidth = 40

// Truncate shortens s to at most max display columns, appending an ellipsis when
// it cuts. Width-aware (counts display width, ignores ANSI), so plain cells only.
func Truncate(s string, max int) string {
	if max <= 0 || lipgloss.Width(s) <= max {
		return s
	}
	if max == 1 {
		return "…"
	}
	r := []rune(s)
	// Trim rune-by-rune until the ellipsis fits within max display columns.
	for len(r) > 0 && lipgloss.Width(string(r))+1 > max {
		r = r[:len(r)-1]
	}
	return string(r) + "…"
}

// renderStaticTable writes a left-aligned, two-space-gutter grayscale table. It
// is intentionally non-interactive so it works in pipes, CI, and tests. Cells are
// capped to MaxColWidth so a long value never overflows the terminal.
func renderStaticTable(out io.Writer, spec TableSpec) error {
	if len(spec.Columns) == 0 {
		return nil
	}
	widths := make([]int, len(spec.Columns))
	for i, h := range spec.Columns {
		widths[i] = lipgloss.Width(Truncate(h, MaxColWidth))
	}
	for _, row := range spec.Rows {
		for i, cell := range row {
			if i < len(widths) {
				if w := lipgloss.Width(Truncate(cell, MaxColWidth)); w > widths[i] {
					widths[i] = w
				}
			}
		}
	}

	var b strings.Builder
	for i, h := range spec.Columns {
		b.WriteString(tableHeaderTextStyle.Render(padCell(Truncate(h, MaxColWidth), widths[i])))
		if i < len(spec.Columns)-1 {
			b.WriteString("  ")
		}
	}
	fmt.Fprintln(out, strings.TrimRight(b.String(), " "))

	for _, row := range spec.Rows {
		b.Reset()
		for i, cell := range row {
			w := 0
			if i < len(widths) {
				w = widths[i]
			}
			b.WriteString(padCell(Truncate(cell, MaxColWidth), w))
			if i < len(row)-1 {
				b.WriteString("  ")
			}
		}
		fmt.Fprintln(out, strings.TrimRight(b.String(), " "))
	}
	return nil
}

// padCell right-pads s with spaces to the given display width.
func padCell(s string, w int) string {
	gap := w - lipgloss.Width(s)
	if gap <= 0 {
		return s
	}
	return s + strings.Repeat(" ", gap)
}
