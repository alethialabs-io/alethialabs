// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/vtx/pkg/utils/ui"
	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/types"
	"github.com/charmbracelet/huh"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

var openVineInBrowser bool

var vineGetCmd = &cobra.Command{
	Use:   "get [project_name]",
	Short: "Get a specific vine by project name",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		projectName := args[0]

		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := getWebOrigin()
		getURL := fmt.Sprintf("%s/api/cli/configurations/by-project-name/%s", webOrigin, projectName)

		client := req.C()
		var result struct {
			Configuration types.Configuration `json:"configuration"`
		}
		var errMsg struct {
			Error string `json:"error"`
		}

		resp, err := client.R().
			SetBearerAuthToken(token).
			SetSuccessResult(&result).
			SetErrorResult(&errMsg).
			Get(getURL)

		if err != nil {
			ui.Error(fmt.Sprintf("Failed to connect to server: %v", err))
			os.Exit(1)
		}

		if resp.IsErrorState() {
			ui.Error(fmt.Sprintf("Failed to fetch vine (HTTP %d): %s", resp.StatusCode, errMsg.Error))
			os.Exit(1)
		}

		if result.Configuration.ID == "" {
			ui.Muted(fmt.Sprintf("No vine found for project: %s", projectName))
			return
		}

		ui.PrintConfiguration(result.Configuration)

		if !openVineInBrowser {
			var confirm bool
			err := huh.NewForm(
				huh.NewGroup(
					huh.NewConfirm().
						Title("Open in Browser").
						Description("View this vine in the Vertex web UI").
						Affirmative("Yes").
						Negative("No").
						Value(&confirm),
				),
			).Run()
			if err == nil {
				openVineInBrowser = confirm
			}
		}

		if openVineInBrowser {
			url := fmt.Sprintf("%s/dashboard", webOrigin)
			fmt.Printf("Opening in browser: %s\n", url)
			if err := browser.OpenURL(url); err != nil {
				ui.Error(fmt.Sprintf("Failed to open browser: %v", err))
			}
		}
	},
}

func init() {
	vineCmd.AddCommand(vineGetCmd)
	vineGetCmd.Flags().BoolVarP(&openVineInBrowser, "open", "o", false, "Open the vine in the web browser")
}
