// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

var projectGetCmd = &cobra.Command{
	Use:   "get [project_name]",
	Short: "Get a specific project by project name",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		projectName := args[0]

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		openInBrowser, _ := cmd.Flags().GetBool("open")

		config, err := api.NewClient(token).GetConfiguration(projectName)
		if err != nil {
			failf("Failed to fetch project: %v", err)
		}

		if config == nil || config.ID == "" {
			ui.Muted(fmt.Sprintf("No project found for project: %s", projectName))
			return
		}

		ui.PrintConfiguration(*config)

		if !openInBrowser {
			var confirm bool
			err := ui.NewForm(
				huh.NewGroup(
					huh.NewConfirm().
						Title("Open in Browser").
						Description("View this project in the Alethia web UI").
						Affirmative("Yes").
						Negative("No").
						Value(&confirm),
				),
			).Run()
			if err == nil {
				openInBrowser = confirm
			}
		}

		if openInBrowser {
			url := fmt.Sprintf("%s/dashboard", WebOrigin())
			fmt.Printf("Opening in browser: %s\n", url)
			if err := browser.OpenURL(url); err != nil {
				ui.Error(fmt.Sprintf("Failed to open browser: %v", err))
			}
		}
	},
}

func init() {
	projectCmd.AddCommand(projectGetCmd)
	// Note: -o is reserved for the global --output flag, so --open is long-only.
	projectGetCmd.Flags().Bool("open", false, "Open the project in the web browser")
}
