// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/charmbracelet/huh/spinner"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
)

type vineyardWithVines struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	CreatedAt   string  `json:"created_at"`
	Vines       []struct {
		ID               string `json:"id"`
		ProjectName      string `json:"project_name"`
		EnvironmentStage string `json:"environment_stage"`
		Status           string `json:"status"`
		Region           string `json:"region"`
	} `json:"vines"`
}

var listVineyardsCmd = &cobra.Command{
	Use:   "list",
	Short: "List all vineyards with their vines",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := getWebOrigin()
		reqClient := req.C()

		var result struct {
			Vineyards []vineyardWithVines `json:"vineyards"`
		}

		spinner.New().
			Title("Fetching vineyards...").
			Action(func() {
				_, err = reqClient.R().
					SetBearerAuthToken(token).
					SetSuccessResult(&result).
					Get(fmt.Sprintf("%s/api/cli/vineyards", webOrigin))
			}).Run()

		if err != nil {
			ui.Error(fmt.Sprintf("Failed to fetch vineyards: %v", err))
			os.Exit(1)
		}

		if len(result.Vineyards) == 0 {
			ui.Muted("No vineyards found. Create one with `alethia vineyard create`.")
			return
		}

		fmt.Println()
		for i, v := range result.Vineyards {
			fmt.Printf("  %s", ui.AccentStyle.Render(v.Name))
			fmt.Println(ui.MutedStyle.Render(fmt.Sprintf(" (%d vines)", len(v.Vines))))

			if v.Description != nil && *v.Description != "" {
				fmt.Printf("  %s\n", ui.MutedStyle.Render(*v.Description))
			}

			if len(v.Vines) > 0 {
				for j, vine := range v.Vines {
					connector := "├─"
					if j == len(v.Vines)-1 {
						connector = "└─"
					}

					status := vine.Status
					if status == "" {
						status = "DRAFT"
					}

					label := ui.TextStyle.Render(fmt.Sprintf("%s (%s)", vine.ProjectName, vine.EnvironmentStage))
					region := ui.MutedStyle.Render(vine.Region)
					fmt.Printf("  %s %s %s — %s  %s\n",
						ui.MutedStyle.Render(connector),
						ui.StatusDot(status),
						label,
						formatVineStatus(status),
						region,
					)
				}
			} else {
				fmt.Printf("  %s\n", ui.MutedStyle.Render("  (no vines)"))
			}

			if i < len(result.Vineyards)-1 {
				fmt.Println(ui.MutedStyle.Render(strings.Repeat("─", 50)))
			}
		}
		fmt.Println()
	},
}

func formatVineStatus(status string) string {
	switch status {
	case "ACTIVE":
		return ui.SuccessStyle.Render("active")
	case "FAILED":
		return ui.ErrorStyle.Render("failed")
	case "DRAFT":
		return ui.MutedStyle.Render("draft")
	case "QUEUED", "PROVISIONING", "DESTROYING":
		return ui.WarningStyle.Render(strings.ToLower(status))
	case "DESTROYED":
		return ui.MutedStyle.Render("destroyed")
	default:
		return ui.MutedStyle.Render(strings.ToLower(status))
	}
}

func init() {
	vineyardCmd.AddCommand(listVineyardsCmd)
}
