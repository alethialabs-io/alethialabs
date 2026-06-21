// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var listZonesCmd = &cobra.Command{
	Use:   "list",
	Short: "List all zones with their specs",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		var zones []api.ZoneWithSpecs

		spinner.New().
			Title("Fetching zones...").
			Action(func() {
				zones, err = api.NewClient(token).GetZones()
			}).Run()

		if err != nil {
			failf("Failed to fetch zones: %v", err)
		}

		if len(zones) == 0 {
			ui.Muted("No zones found. Create one with `alethia zone create`.")
			return
		}

		fmt.Println()
		for i, v := range zones {
			fmt.Printf("  %s", ui.AccentStyle.Render(v.Name))
			fmt.Println(ui.MutedStyle.Render(fmt.Sprintf(" (%d specs)", len(v.Specs))))

			if v.Description != nil && *v.Description != "" {
				fmt.Printf("  %s\n", ui.MutedStyle.Render(*v.Description))
			}

			if len(v.Specs) > 0 {
				for j, spec := range v.Specs {
					connector := "├─"
					if j == len(v.Specs)-1 {
						connector = "└─"
					}

					status := spec.Status
					if status == "" {
						status = "DRAFT"
					}

					label := ui.TextStyle.Render(fmt.Sprintf("%s (%s)", spec.ProjectName, spec.EnvironmentStage))
					region := ui.MutedStyle.Render(spec.Region)
					fmt.Printf("  %s %s %s — %s  %s\n",
						ui.MutedStyle.Render(connector),
						ui.StatusDot(status),
						label,
						formatSpecStatus(status),
						region,
					)
				}
			} else {
				fmt.Printf("  %s\n", ui.MutedStyle.Render("  (no specs)"))
			}

			if i < len(zones)-1 {
				fmt.Println(ui.MutedStyle.Render(strings.Repeat("─", 50)))
			}
		}
		fmt.Println()
	},
}

func formatSpecStatus(status string) string {
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
	zoneCmd.AddCommand(listZonesCmd)
}
