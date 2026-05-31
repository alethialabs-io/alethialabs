package cmd

import (
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dustin/go-humanize"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var listVineyardsCmd = &cobra.Command{
	Use:   "list",
	Short: "List all vineyards (workspaces)",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
		if webOrigin == "" {
			webOrigin = "https://adp.prod.itgix.eu"
		}
		listURL := fmt.Sprintf("%s/api/cli/vineyards", webOrigin)

		client := req.C()
		var result struct {
			Vineyards []types.Vineyard `json:"vineyards"`
		}
		var errMsg struct {
			Error string `json:"error"`
		}

		resp, err := client.R().
			SetBearerAuthToken(token).
			SetSuccessResult(&result).
			SetErrorResult(&errMsg).
			Get(listURL)

		if err != nil {
			fmt.Printf("Error connecting to server: %v\n", err)
			os.Exit(1)
		}

		if resp.IsErrorState() {
			fmt.Printf("Error fetching vineyards (HTTP %d): %s\n", resp.StatusCode, errMsg.Error)
			os.Exit(1)
		}

		if len(result.Vineyards) == 0 {
			fmt.Println("No vineyards found.")
			return
		}

		width, height, err := term.GetSize(int(os.Stdout.Fd()))
		if err != nil {
			height = 20
		}
		tableHeight := int(float64(height) * 0.8)

		columns := []table.Column{
			{Title: "Name", Width: width / 3},
			{Title: "Description", Width: width / 3},
			{Title: "Created At", Width: width / 4},
		}

		rows := createVineyardRows(result.Vineyards)

		t := table.New(
			table.WithColumns(columns),
			table.WithRows(rows),
			table.WithFocused(true),
			table.WithHeight(tableHeight),
		)

		s := table.DefaultStyles()
		s.Header = lipgloss.NewStyle().
			Foreground(lipgloss.Color("252")).
			BorderStyle(lipgloss.ThickBorder()).
			BorderBottom(true).
			Bold(true).
			Padding(0, 1)

		s.Selected = lipgloss.NewStyle().
			Background(lipgloss.Color("#008080")).
			Foreground(lipgloss.Color("#FFFFFF")).
			Bold(false)

		t.SetStyles(s)

		m := vineyardListModel{table: t, originalRows: rows, vineyards: result.Vineyards}
		if _, err := tea.NewProgram(m).Run(); err != nil {
			fmt.Println("Error running program:", err)
			os.Exit(1)
		}
	},
}

type vineyardListModel struct {
	table        table.Model
	originalRows []table.Row
	vineyards    []types.Vineyard
	sortAsc      bool
}

func (m vineyardListModel) Init() tea.Cmd { return nil }

func (m vineyardListModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "s":
			m.sortAsc = !m.sortAsc
			sort.Slice(m.vineyards, func(i, j int) bool {
				if m.sortAsc {
					return m.vineyards[i].Name < m.vineyards[j].Name
				}
				return m.vineyards[i].Name > m.vineyards[j].Name
			})
			m.table.SetRows(createVineyardRows(m.vineyards))
			return m, nil
		}
	}
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

var vineyardBaseStyle = lipgloss.NewStyle().
	BorderStyle(lipgloss.RoundedBorder()).
	BorderForeground(lipgloss.Color("240"))

func (m vineyardListModel) View() string {
	status := fmt.Sprintf("Showing %d vineyards | Press 'q' to quit | 'j/k' or arrows to navigate | 's' to sort by Name", len(m.table.Rows()))
	statusStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Padding(0, 1)
	return vineyardBaseStyle.Render(m.table.View()) + "\n" + statusStyle.Render(status)
}

func createVineyardRows(vineyards []types.Vineyard) []table.Row {
	var rows []table.Row
	for _, v := range vineyards {
		desc := ""
		if v.Description != nil {
			desc = *v.Description
		}
		rows = append(rows, table.Row{
			v.Name,
			desc,
			formatVineyardTime(v.CreatedAt),
		})
	}
	return rows
}

func formatVineyardTime(t time.Time) string {
	if time.Since(t).Hours() < 24*7 {
		return humanize.Time(t)
	}
	return t.Format("2006-01-02 15:04")
}

func init() {
	vineyardCmd.AddCommand(listVineyardsCmd)
}
