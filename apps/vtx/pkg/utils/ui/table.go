// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"

	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var (
	tableHeaderStyle = lipgloss.NewStyle().
				BorderStyle(lipgloss.NormalBorder()).
				BorderForeground(lipgloss.Color(ColorMuted)).
				BorderBottom(true).
				Bold(true)

	tableSelectedStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color(ColorSelect)).
				Background(lipgloss.Color(ColorAccent)).
				Bold(false)

	tableBorderStyle = lipgloss.NewStyle().
				BorderStyle(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color(ColorMuted))
)

func NewStyledTable(columns []table.Column, rows []table.Row) table.Model {
	height := len(rows) + 1
	if height > 20 {
		height = 20
	}

	t := table.New(
		table.WithColumns(columns),
		table.WithRows(rows),
		table.WithFocused(true),
		table.WithHeight(height),
	)

	s := table.DefaultStyles()
	s.Header = tableHeaderStyle
	s.Selected = tableSelectedStyle
	t.SetStyles(s)

	return t
}

func SortRowsByCol(rows []table.Row, col int, asc bool) {
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			if asc && rows[i][col] > rows[j][col] {
				rows[i], rows[j] = rows[j], rows[i]
			} else if !asc && rows[i][col] < rows[j][col] {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}
}

// --- Standard (non-paginated) TableModel ---

type TableModel struct {
	Table    table.Model
	SortCol  int
	SortAsc  bool
	Entity   string
	SortName string
	Quitting bool
}

func NewTableModel(columns []table.Column, rows []table.Row, entity, sortName string, sortCol int) TableModel {
	return TableModel{
		Table:    NewStyledTable(columns, rows),
		SortCol:  sortCol,
		Entity:   entity,
		SortName: sortName,
	}
}

func (m TableModel) Init() tea.Cmd { return nil }

func (m TableModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			m.Quitting = true
			return m, tea.Quit
		case "s":
			rows := m.Table.Rows()
			m.SortAsc = !m.SortAsc
			SortRowsByCol(rows, m.SortCol, m.SortAsc)
			m.Table.SetRows(rows)
			return m, nil
		}
	}
	m.Table, cmd = m.Table.Update(msg)
	return m, cmd
}

func (m TableModel) View() string {
	if m.Quitting {
		return ""
	}
	footer := MutedStyle.Render(fmt.Sprintf("  q: quit · s: sort by %s · ↑↓/jk: navigate", m.SortName))
	return "\n" + tableBorderStyle.Render(m.Table.View()) + "\n" + footer + "\n"
}

// --- Paginated TableModel ---

type PageChangedMsg struct {
	Page int
}

type PageDataMsg struct {
	Rows       []table.Row
	Total      int
	Page       int
	TotalPages int
}

type PaginatedTableModel struct {
	Table      table.Model
	Columns    []table.Column
	Entity     string
	Page       int
	TotalPages int
	Total      int
	PageSize   int
	Loading    bool
	Quitting   bool
}

func NewPaginatedTableModel(columns []table.Column, rows []table.Row, entity string, total, pageSize int) PaginatedTableModel {
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}
	return PaginatedTableModel{
		Table:      NewStyledTable(columns, rows),
		Columns:    columns,
		Entity:     entity,
		Page:       1,
		TotalPages: totalPages,
		Total:      total,
		PageSize:   pageSize,
	}
}

func (m PaginatedTableModel) Init() tea.Cmd { return nil }

func (m PaginatedTableModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			m.Quitting = true
			return m, tea.Quit
		case "n":
			if m.Page < m.TotalPages && !m.Loading {
				m.Page++
				m.Loading = true
				return m, func() tea.Msg { return PageChangedMsg{Page: m.Page} }
			}
			return m, nil
		case "p":
			if m.Page > 1 && !m.Loading {
				m.Page--
				m.Loading = true
				return m, func() tea.Msg { return PageChangedMsg{Page: m.Page} }
			}
			return m, nil
		}
	case PageDataMsg:
		m.Loading = false
		m.Page = msg.Page
		m.TotalPages = msg.TotalPages
		m.Total = msg.Total
		m.Table = NewStyledTable(m.Columns, msg.Rows)
		return m, nil
	}
	m.Table, cmd = m.Table.Update(msg)
	return m, cmd
}

func (m PaginatedTableModel) View() string {
	if m.Quitting {
		return ""
	}
	var status string
	if m.Loading {
		status = MutedStyle.Render("  Loading...")
	} else {
		status = MutedStyle.Render(fmt.Sprintf(
			"  Page %d/%d (%d %s) · n/p: page · q: quit · ↑↓/jk: navigate",
			m.Page, m.TotalPages, m.Total, m.Entity,
		))
	}
	return "\n" + tableBorderStyle.Render(m.Table.View()) + "\n" + status + "\n"
}
