package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

var workerRemoveCmd = &cobra.Command{
	Use:   "remove [worker_id]",
	Short: "Remove a worker record (no cloud teardown)",
	Long:  `Remove deletes the worker record from the database. Use 'grape destroy worker' to tear down cloud infrastructure.`,
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		workerID := ""
		if len(args) > 0 {
			workerID = args[0]
		}

		if workerID == "" {
			workerID, err = selectWorker(token)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Remove this worker record?").
					Description("This only removes the database record. Use `grape destroy worker` to tear down cloud resources.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		apiClient := api.NewClient(token)

		spinner.New().
			Title("Removing worker...").
			Action(func() {
				err = apiClient.RemoveWorker(workerID)
			}).Run()

		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
		fmt.Printf("%s Worker removed\n", successStyle.Render("✓"))
	},
}

func init() {
	workerCmd.AddCommand(workerRemoveCmd)
}
