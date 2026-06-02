package cmd

import (
	"fmt"
	"os"
	"sort"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh/spinner"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var workerListCmd = &cobra.Command{
	Use:   "list",
	Short: "List registered workers",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)
		var workers []api.Worker

		spinner.New().
			Title("Fetching workers...").
			Action(func() {
				workers, err = apiClient.GetWorkers()
			}).Run()

		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if len(workers) == 0 {
			fmt.Println("No workers found. Register one with `grape worker register`.")
			return
		}

		width, height, err := term.GetSize(int(os.Stdout.Fd()))
		if err != nil {
			height = 20
		}
		tableHeight := int(float64(height) * 0.8)

		columns := []table.Column{
			{Title: "Name", Width: width / 5},
			{Title: "Mode", Width: width / 7},
			{Title: "Status", Width: width / 7},
			{Title: "Version", Width: width / 7},
			{Title: "Default", Width: width / 10},
		}

		rows := createWorkerRows(workers)

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

		m := workerListModel{table: t, workers: workers}
		if _, err := tea.NewProgram(m).Run(); err != nil {
			fmt.Println("Error running program:", err)
			os.Exit(1)
		}
	},
}

type workerListModel struct {
	table   table.Model
	workers []api.Worker
	sortAsc bool
}

func (m workerListModel) Init() tea.Cmd { return nil }

func (m workerListModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "s":
			m.sortAsc = !m.sortAsc
			sort.Slice(m.workers, func(i, j int) bool {
				if m.sortAsc {
					return m.workers[i].Name < m.workers[j].Name
				}
				return m.workers[i].Name > m.workers[j].Name
			})
			m.table.SetRows(createWorkerRows(m.workers))
			return m, nil
		}
	}
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m workerListModel) View() string {
	status := fmt.Sprintf("Showing %d workers | Press 'q' to quit | 'j/k' or arrows to navigate | 's' to sort", len(m.table.Rows()))
	statusStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Padding(0, 1)
	return baseStyle.Render(m.table.View()) + "\n" + statusStyle.Render(status)
}

func createWorkerRows(workers []api.Worker) []table.Row {
	var rows []table.Row
	for _, w := range workers {
		statusIcon := "🟡"
		switch w.Status {
		case "ONLINE":
			statusIcon = "🟢"
		case "OFFLINE":
			statusIcon = "🔴"
		case "DRAINING":
			statusIcon = "🟡"
		}
		defaultStr := ""
		if w.IsDefault {
			defaultStr = "★"
		}
		rows = append(rows, table.Row{
			w.Name,
			w.Mode,
			statusIcon + " " + w.Status,
			w.Version,
			defaultStr,
		})
	}
	return rows
}

func init() {
	workerCmd.AddCommand(workerListCmd)
}
