// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
)

// keyRunes builds a bubbletea key message for a single rune, so the table
// models can be driven headlessly without a terminal.
func keyRunes(r rune) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}}
}

// demoColumns returns a stable two-column spec for the table model tests.
func demoColumns() []table.Column {
	return []table.Column{{Title: "Name", Width: 10}, {Title: "Status", Width: 10}}
}

// demoRows returns deterministic, deliberately unsorted rows.
func demoRows() []table.Row {
	return []table.Row{
		{"charlie", "FAILED"},
		{"alpha", "ONLINE"},
		{"bravo", "QUEUED"},
	}
}

func TestSortRowsByCol(t *testing.T) {
	tests := []struct {
		name string
		col  int
		asc  bool
		want []string
	}{
		{name: "ascending by name", col: 0, asc: true, want: []string{"alpha", "bravo", "charlie"}},
		{name: "descending by name", col: 0, asc: false, want: []string{"charlie", "bravo", "alpha"}},
		// Statuses sort FAILED < ONLINE < QUEUED, i.e. charlie < alpha < bravo.
		{name: "ascending by status", col: 1, asc: true, want: []string{"charlie", "alpha", "bravo"}},
		{name: "descending by status", col: 1, asc: false, want: []string{"bravo", "alpha", "charlie"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows := demoRows()
			SortRowsByCol(rows, tt.col, tt.asc)
			for i, want := range tt.want {
				if rows[i][0] != want {
					t.Errorf("row %d = %q, want %q (got %v)", i, rows[i][0], want, rows)
				}
			}
		})
	}
}

func TestSortRowsByColEmpty(t *testing.T) {
	var rows []table.Row
	SortRowsByCol(rows, 0, true)
	if len(rows) != 0 {
		t.Errorf("expected the empty slice to be untouched, got %v", rows)
	}
}

func TestNewStyledTableHeightCap(t *testing.T) {
	tests := []struct {
		name    string
		numRows int
		want    int
	}{
		{name: "empty", numRows: 0, want: 0},
		{name: "single row", numRows: 1, want: 1},
		{name: "under the cap", numRows: 5, want: 5},
		{name: "at the cap", numRows: 19, want: 19},
		{name: "over the cap is clamped", numRows: 200, want: 19},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows := make([]table.Row, tt.numRows)
			for i := range rows {
				rows[i] = table.Row{"n", "s"}
			}
			if got := NewStyledTable(demoColumns(), rows).Height(); got != tt.want {
				t.Errorf("Height() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestNewStyledTableRendersHeaderAndRows(t *testing.T) {
	view := NewStyledTable(demoColumns(), demoRows()).View()
	for _, want := range []string{"Name", "Status", "alpha", "bravo", "charlie"} {
		if !strings.Contains(view, want) {
			t.Errorf("styled table missing %q:\n%s", want, view)
		}
	}
}

func TestTableModelInitAndView(t *testing.T) {
	m := NewTableModel(demoColumns(), demoRows(), "clusters", "Name", 0)
	if cmd := m.Init(); cmd != nil {
		t.Error("Init must not schedule a command")
	}
	view := m.View()
	if !strings.Contains(view, "q: quit") || !strings.Contains(view, "sort by Name") {
		t.Errorf("footer missing the key hints:\n%s", view)
	}
	if !strings.Contains(view, "charlie") {
		t.Errorf("view missing a row:\n%s", view)
	}
}

func TestTableModelQuitKeys(t *testing.T) {
	for _, key := range []tea.KeyMsg{keyRunes('q'), {Type: tea.KeyCtrlC}} {
		m := NewTableModel(demoColumns(), demoRows(), "clusters", "Name", 0)
		next, cmd := m.Update(key)
		tm, ok := next.(TableModel)
		if !ok {
			t.Fatalf("Update returned %T, want TableModel", next)
		}
		if !tm.Quitting {
			t.Errorf("%v did not set Quitting", key)
		}
		if cmd == nil {
			t.Errorf("%v did not return the quit command", key)
		}
		if got := tm.View(); got != "" {
			t.Errorf("a quitting model must render nothing, got %q", got)
		}
	}
}

func TestTableModelSortKeyTogglesDirection(t *testing.T) {
	m := NewTableModel(demoColumns(), demoRows(), "clusters", "Name", 0)

	next, cmd := m.Update(keyRunes('s'))
	tm, ok := next.(TableModel)
	if !ok {
		t.Fatalf("Update returned %T, want TableModel", next)
	}
	if cmd != nil {
		t.Error("the sort key must not schedule a command")
	}
	if !tm.SortAsc {
		t.Error("the first sort keypress must select ascending")
	}
	if first := tm.Table.Rows()[0][0]; first != "alpha" {
		t.Errorf("ascending sort put %q first, want %q", first, "alpha")
	}

	next, _ = tm.Update(keyRunes('s'))
	tm2, ok := next.(TableModel)
	if !ok {
		t.Fatalf("Update returned %T, want TableModel", next)
	}
	if tm2.SortAsc {
		t.Error("the second sort keypress must flip to descending")
	}
	if first := tm2.Table.Rows()[0][0]; first != "charlie" {
		t.Errorf("descending sort put %q first, want %q", first, "charlie")
	}
}

func TestTableModelForwardsUnhandledKeys(t *testing.T) {
	m := NewTableModel(demoColumns(), demoRows(), "clusters", "Name", 0)
	next, _ := m.Update(keyRunes('j'))
	tm, ok := next.(TableModel)
	if !ok {
		t.Fatalf("Update returned %T, want TableModel", next)
	}
	if tm.Quitting {
		t.Error("an unrelated key must not quit")
	}
	if got := tm.Table.Cursor(); got != 1 {
		t.Errorf("cursor = %d after 'j', want 1", got)
	}
}

func TestNewPaginatedTableModelTotalPages(t *testing.T) {
	tests := []struct {
		name     string
		total    int
		pageSize int
		want     int
	}{
		{name: "no records still has one page", total: 0, pageSize: 20, want: 1},
		{name: "exact multiple", total: 40, pageSize: 20, want: 2},
		{name: "partial last page", total: 41, pageSize: 20, want: 3},
		{name: "single short page", total: 3, pageSize: 20, want: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := NewPaginatedTableModel(demoColumns(), demoRows(), "jobs", tt.total, tt.pageSize)
			if m.TotalPages != tt.want {
				t.Errorf("TotalPages = %d, want %d", m.TotalPages, tt.want)
			}
			if m.Page != 1 {
				t.Errorf("Page = %d, want it to start at 1", m.Page)
			}
			if m.Loading {
				t.Error("a fresh model must not be loading")
			}
		})
	}
}

func TestPaginatedTableModelPaging(t *testing.T) {
	m := NewPaginatedTableModel(demoColumns(), demoRows(), "jobs", 100, 20)
	if cmd := m.Init(); cmd != nil {
		t.Error("Init must not schedule a command")
	}

	// "p" on the first page is a no-op.
	next, cmd := m.Update(keyRunes('p'))
	pm, ok := next.(PaginatedTableModel)
	if !ok {
		t.Fatalf("Update returned %T, want PaginatedTableModel", next)
	}
	if pm.Page != 1 || cmd != nil || pm.Loading {
		t.Errorf("'p' on page 1 changed state: page=%d loading=%v cmd=%v", pm.Page, pm.Loading, cmd != nil)
	}

	// "n" advances and asks the host for the page.
	next, cmd = pm.Update(keyRunes('n'))
	pm, ok = next.(PaginatedTableModel)
	if !ok {
		t.Fatalf("Update returned %T, want PaginatedTableModel", next)
	}
	if pm.Page != 2 || !pm.Loading {
		t.Errorf("'n' left page=%d loading=%v, want page=2 loading=true", pm.Page, pm.Loading)
	}
	if cmd == nil {
		t.Fatal("'n' must return a PageChangedMsg command")
	}
	msg, ok := cmd().(PageChangedMsg)
	if !ok {
		t.Fatalf("command produced %T, want PageChangedMsg", cmd())
	}
	if msg.Page != 2 {
		t.Errorf("PageChangedMsg.Page = %d, want 2", msg.Page)
	}

	// A second "n" while loading is ignored.
	next, cmd = pm.Update(keyRunes('n'))
	pm, ok = next.(PaginatedTableModel)
	if !ok {
		t.Fatalf("Update returned %T, want PaginatedTableModel", next)
	}
	if pm.Page != 2 || cmd != nil {
		t.Errorf("'n' while loading advanced to page %d", pm.Page)
	}

	// The delivered page clears the loading state and swaps the rows in.
	next, cmd = pm.Update(PageDataMsg{
		Rows:       []table.Row{{"delta", "ONLINE"}},
		Total:      99,
		Page:       2,
		TotalPages: 5,
	})
	pm, ok = next.(PaginatedTableModel)
	if !ok {
		t.Fatalf("Update returned %T, want PaginatedTableModel", next)
	}
	if pm.Loading || cmd != nil {
		t.Errorf("PageDataMsg left loading=%v cmd=%v", pm.Loading, cmd != nil)
	}
	if pm.Page != 2 || pm.TotalPages != 5 || pm.Total != 99 {
		t.Errorf("page state = %d/%d (%d), want 2/5 (99)", pm.Page, pm.TotalPages, pm.Total)
	}
	if !strings.Contains(pm.Table.View(), "delta") {
		t.Errorf("the delivered rows were not installed:\n%s", pm.Table.View())
	}

	// "p" now steps back.
	next, cmd = pm.Update(keyRunes('p'))
	pm, ok = next.(PaginatedTableModel)
	if !ok {
		t.Fatalf("Update returned %T, want PaginatedTableModel", next)
	}
	if pm.Page != 1 || !pm.Loading || cmd == nil {
		t.Errorf("'p' left page=%d loading=%v", pm.Page, pm.Loading)
	}
}

func TestPaginatedTableModelQuitAndView(t *testing.T) {
	m := NewPaginatedTableModel(demoColumns(), demoRows(), "jobs", 42, 20)

	view := m.View()
	for _, want := range []string{"Page 1/3", "42 jobs", "n/p: page", "q: quit"} {
		if !strings.Contains(view, want) {
			t.Errorf("status line missing %q:\n%s", want, view)
		}
	}

	loading := m
	loading.Loading = true
	if !strings.Contains(loading.View(), "Loading...") {
		t.Errorf("a loading model must say so:\n%s", loading.View())
	}

	next, cmd := m.Update(keyRunes('q'))
	pm, ok := next.(PaginatedTableModel)
	if !ok {
		t.Fatalf("Update returned %T, want PaginatedTableModel", next)
	}
	if !pm.Quitting || cmd == nil {
		t.Errorf("'q' left quitting=%v cmd=%v", pm.Quitting, cmd != nil)
	}
	if got := pm.View(); got != "" {
		t.Errorf("a quitting model must render nothing, got %q", got)
	}
}

func TestPaginatedTableModelForwardsUnhandledKeys(t *testing.T) {
	m := NewPaginatedTableModel(demoColumns(), demoRows(), "jobs", 3, 20)
	next, _ := m.Update(keyRunes('j'))
	pm, ok := next.(PaginatedTableModel)
	if !ok {
		t.Fatalf("Update returned %T, want PaginatedTableModel", next)
	}
	if got := pm.Table.Cursor(); got != 1 {
		t.Errorf("cursor = %d after 'j', want 1", got)
	}
}
