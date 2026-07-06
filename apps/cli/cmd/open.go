// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

var openCmd = &cobra.Command{
	Use:       "open [console|docs]",
	Aliases:   []string{"docs", "dashboard"},
	Short:     "Open the Alethia console or docs in your browser",
	Long:      `Open the Alethia web console (default) or the documentation in your default browser.`,
	ValidArgs: []string{"console", "docs", "dashboard"},
	Args:      cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		target := "console"
		// `alethia docs` (the alias) defaults to the docs target.
		if cmd.CalledAs() == "docs" {
			target = "docs"
		}
		if len(args) > 0 {
			target = args[0]
		}

		var url string
		switch target {
		case "console", "dashboard":
			url = WebOrigin()
		case "docs":
			url = docsURL
		default:
			failf("unknown target %q (want console or docs)", target)
		}

		fmt.Printf("Opening %s\n", url)
		if err := browser.OpenURL(url); err != nil {
			ui.Error(fmt.Sprintf("Failed to open browser: %v", err))
		}
	},
}

func init() {
	rootCmd.AddCommand(openCmd)
}
