package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/vtx/pkg/utils/ui"
	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/api"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var jobsCancelCmd = &cobra.Command{
	Use:   "cancel <job_id>",
	Short: "Cancel a queued or processing job",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		jobID := args[0]

		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		apiClient := api.NewClient(token)

		spinner.New().
			Title("Cancelling job...").
			Action(func() {
				err = apiClient.CancelJob(jobID)
			}).Run()

		if err != nil {
			ui.Error(fmt.Sprintf("Failed to cancel job: %v", err))
			os.Exit(1)
		}

		ui.Success(fmt.Sprintf("Job %s cancelled", jobID))
	},
}

func init() {
	jobsCmd.AddCommand(jobsCancelCmd)
}
