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

var (
	jobsListStatus     string
	jobsListVineyardID string
	jobsListLimit      int
)

var jobsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all provisioning jobs",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)
		var jobs []api.ProvisionJob

		spinner.New().
			Title("Fetching jobs...").
			Action(func() {
				jobs, err = apiClient.GetJobs(jobsListStatus, jobsListVineyardID)
			}).Run()

		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		if len(jobs) == 0 {
			fmt.Println("No jobs found.")
			return
		}

		if jobsListLimit > 0 && len(jobs) > jobsListLimit {
			jobs = jobs[:jobsListLimit]
		}

		width, height, err := term.GetSize(int(os.Stdout.Fd()))
		if err != nil {
			height = 20
		}
		tableHeight := int(float64(height) * 0.8)

		columns := []table.Column{
			{Title: "ID", Width: width / 6},
			{Title: "Type", Width: width / 7},
			{Title: "Status", Width: width / 7},
			{Title: "Created", Width: width / 5},
		}

		rows := createJobRows(jobs)

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

		m := jobsListModel{table: t, jobs: jobs}
		if _, err := tea.NewProgram(m).Run(); err != nil {
			fmt.Println("Error running program:", err)
			os.Exit(1)
		}
	},
}

type jobsListModel struct {
	table   table.Model
	jobs    []api.ProvisionJob
	sortAsc bool
}

func (m jobsListModel) Init() tea.Cmd { return nil }

func (m jobsListModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "s":
			m.sortAsc = !m.sortAsc
			sort.Slice(m.jobs, func(i, j int) bool {
				if m.sortAsc {
					return m.jobs[i].CreatedAt.Before(m.jobs[j].CreatedAt)
				}
				return m.jobs[i].CreatedAt.After(m.jobs[j].CreatedAt)
			})
			m.table.SetRows(createJobRows(m.jobs))
			return m, nil
		}
	}
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m jobsListModel) View() string {
	status := fmt.Sprintf("Showing %d jobs | Press 'q' to quit | 'j/k' or arrows to navigate | 's' to sort by date", len(m.table.Rows()))
	statusStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Padding(0, 1)
	return baseStyle.Render(m.table.View()) + "\n" + statusStyle.Render(status)
}

func createJobRows(jobs []api.ProvisionJob) []table.Row {
	var rows []table.Row
	for _, j := range jobs {
		id := j.ID
		if len(id) > 8 {
			id = id[:8] + "..."
		}
		rows = append(rows, table.Row{
			id,
			j.JobType,
			j.Status,
			j.CreatedAt.Format("2006-01-02 15:04"),
		})
	}
	return rows
}

func init() {
	jobsCmd.AddCommand(jobsListCmd)
	jobsListCmd.Flags().StringVar(&jobsListStatus, "status", "", "Filter by status (QUEUED, CLAIMED, PROCESSING, SUCCESS, FAILED, CANCELLED)")
	jobsListCmd.Flags().StringVar(&jobsListVineyardID, "vineyard-id", "", "Filter by vineyard ID")
	jobsListCmd.Flags().IntVarP(&jobsListLimit, "limit", "n", 20, "Maximum number of jobs to display")
}
