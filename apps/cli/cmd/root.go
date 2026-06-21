// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

const (
	websiteURL = "https://alethialabs.io"
	docsURL    = "https://alethialabs.io/docs"
)

func init() {
	rootCmd.Version = version.Version
}

var rootCmd = &cobra.Command{
	Use:   "alethia",
	Short: "alethia — multi-cloud Kubernetes control plane, from the terminal",
	Long: `alethia is the command-line interface to the Alethia control plane.
Configure infrastructure visually, then plan, deploy, and tear it down across
AWS, GCP, and Azure from the terminal.`,
	// Runs after any subcommand that doesn't override it — surfaces the upgrade
	// notice once per day without ever blocking the command.
	PersistentPostRun: func(cmd *cobra.Command, args []string) {
		update.CheckAndNotify(version.Version)
	},
	Run: func(cmd *cobra.Command, args []string) {
		printBanner()
		fmt.Println()
		cmd.Help()
	},
}

// printBanner renders the grayscale Alethia lockup shown for a bare `alethia`.
func printBanner() {
	ver := version.Version

	fmt.Println()
	fmt.Printf("  %s %s   %s\n",
		ui.RenderMark(),
		ui.StrongStyle.Render("alethia"),
		ui.Eyebrow("control plane"),
	)
	fmt.Printf("  %s\n", ui.SecondaryStyle.Render("Configure infrastructure visually. Deploy from the terminal."))
	fmt.Println()

	row := func(label, value string) {
		fmt.Printf("  %s  %s\n", ui.MutedStyle.Render(fmt.Sprintf("%-9s", label)), value)
	}
	row("version", ui.TextStyle.Render(ver))
	row("website", ui.LinkStyle.Render(websiteURL))
	row("docs", ui.LinkStyle.Render(docsURL))
}

// WebOrigin returns the Alethia control-plane URL from ALETHIA_WEB_ORIGIN. It is
// required (no default) — the CLI exits with a clear message when it is unset.
func WebOrigin() string {
	v := os.Getenv("ALETHIA_WEB_ORIGIN")
	if v == "" {
		fmt.Fprintln(os.Stderr, "Error: ALETHIA_WEB_ORIGIN is required (set it to your Alethia control-plane URL).")
		os.Exit(1)
	}
	return v
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fail(err)
	}
}
