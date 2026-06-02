package cmd

import (
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/dustin/go-humanize"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var listVinesCmd = &cobra.Command{
	Use:   "list",
	Short: "List all vines",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := getWebOrigin()
		listURL := fmt.Sprintf("%s/api/cli/configurations", webOrigin)

		client := req.C()
		var result struct {
			Configurations []types.ConfigurationSummary `json:"configurations"`
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
			fmt.Printf("Error fetching vines (HTTP %d): %s\n", resp.StatusCode, errMsg.Error)
			os.Exit(1)
		}

		if len(result.Configurations) == 0 {
			fmt.Println("No vines found.")
			return
		}

		width, height, err := term.GetSize(int(os.Stdout.Fd()))
		if err != nil {
			height = 20
		}
		tableHeight := int(float64(height) * 0.8)

		columns := []table.Column{
			{Title: "Project", Width: width / 5},
			{Title: "Environment", Width: width / 6},
			{Title: "Status", Width: width / 6},
			{Title: "Updated At", Width: width / 6},
		}

		rows := createVineRows(result.Configurations)

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

		m := vineListModel{table: t, originalRows: rows, vines: result.Configurations}
		if _, err := tea.NewProgram(m).Run(); err != nil {
			fmt.Println("Error running program:", err)
			os.Exit(1)
		}
	},
}

type vineListModel struct {
	table        table.Model
	originalRows []table.Row
	vines        []types.ConfigurationSummary
	sortAsc      bool
}

func (m vineListModel) Init() tea.Cmd { return nil }

func (m vineListModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "s":
			m.sortAsc = !m.sortAsc
			sort.Slice(m.vines, func(i, j int) bool {
				if m.sortAsc {
					return m.vines[i].ProjectName < m.vines[j].ProjectName
				}
				return m.vines[i].ProjectName > m.vines[j].ProjectName
			})
			m.table.SetRows(createVineRows(m.vines))
			return m, nil
		}
	}
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m vineListModel) View() string {
	status := fmt.Sprintf("Showing %d vines | Press 'q' to quit | 'j/k' or arrows to navigate | 's' to sort by Project", len(m.table.Rows()))
	statusStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Padding(0, 1)
	return baseStyle.Render(m.table.View()) + "\n" + statusStyle.Render(status)
}

var baseStyle = lipgloss.NewStyle().
	BorderStyle(lipgloss.RoundedBorder()).
	BorderForeground(lipgloss.Color("240"))

func createVineRows(vines []types.ConfigurationSummary) []table.Row {
	var rows []table.Row
	for _, v := range vines {
		rows = append(rows, table.Row{
			v.ProjectName,
			v.EnvironmentStage,
			v.ContainerPlatform,
			formatVineTime(v.UpdatedAt),
		})
	}
	return rows
}

func formatVineTime(t time.Time) string {
	if time.Since(t).Hours() < 24*7 {
		return humanize.Time(t)
	}
	return t.Format("2006-01-02 15:04")
}

func init() {
	vineCmd.AddCommand(listVinesCmd)
}
