// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

var tendrilRemoveCmd = &cobra.Command{
	Use:   "remove [runner_id]",
	Short: "Remove a runner record (no cloud teardown)",
	Long:  `Removes the runner's database record only. Use 'alethia runner destroy' to tear down cloud resources first.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		tendrilID := ""
		if len(args) > 0 {
			tendrilID = args[0]
		} else {
			tendrilID, err = selectTendril(token, "")
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
			if tendrilID == "" {
				fmt.Println("Please select a specific runner, not 'Any available'.")
				os.Exit(1)
			}
		}

		var confirm bool
		confirmForm := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Remove this runner record?").
					Description("This only removes the database record. Cloud resources will NOT be torn down.").
					Value(&confirm),
			),
		)
		if err := confirmForm.Run(); err != nil || !confirm {
			fmt.Println("Operation cancelled.")
			return
		}

		apiClient := api.NewClient(token)

		spinner.New().
			Title("Removing runner...").
			Action(func() {
				err = apiClient.RemoveWorker(tendrilID)
			}).Run()

		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}

		ui.Success(fmt.Sprintf("Runner record removed (ID: %s)", tendrilID))
	},
}

func init() {
	tendrilCmd.AddCommand(tendrilRemoveCmd)
}
