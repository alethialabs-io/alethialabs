// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

const (
	websiteURL                 = "https://alethialabs.io"
	docsURL                    = "https://alethialabs.io/docs"
	skipUpdateNoticeAnnotation = "alethia.io/skip-update-notice"
)

func init() {
	rootCmd.Version = version.Version
	rootCmd.PersistentFlags().StringP("output", "o", "table", "Output format: table, json, or csv")
	rootCmd.PersistentFlags().Bool("no-input", false, "Disable interactive prompts (fail instead of prompting)")
	// The NON-INTERACTIVE credential. Pairs with --no-input: that one stops the CLI asking
	// questions, this one gives it an answer to the only question a pipeline cannot answer.
	// Prefer $ALETHIA_TOKEN in CI — a flag value lands in the process table and in shell history,
	// where an environment variable does not.
	rootCmd.PersistentFlags().StringVar(&serviceTokenFlag, "token", "",
		"Service-account `token` for non-interactive use (or set $"+ServiceTokenEnv+"). Skips the interactive login entirely.")
}

var rootCmd = &cobra.Command{
	Use:   "alethia",
	Short: "alethia — multi-cloud Kubernetes control plane, from the terminal",
	Long: `alethia is the command-line interface to the Alethia control plane.
Configure infrastructure visually, then plan, deploy, and tear it down across
AWS, GCP, and Azure from the terminal.`,
	// Resolves the input mode (--no-input / non-TTY stdin) before any subcommand
	// runs, so the interactive selectors know whether prompting is allowed.
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		resolveInputMode(cmd)
	},
	// Runs after any subcommand that doesn't override it — surfaces the upgrade
	// notice once per day without ever blocking the command.
	PersistentPostRun: func(cmd *cobra.Command, args []string) {
		if cmd.Annotations != nil && cmd.Annotations[skipUpdateNoticeAnnotation] == "true" {
			return
		}
		update.CheckAndNotify(version.Version, WebOrigin())
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

// WebOrigin returns the Alethia control-plane URL, resolved as
// ALETHIA_WEB_ORIGIN env > persisted config > the hosted default. Prod needs no
// setup; self-host/dev override it via `alethia config set web-origin` or the env.
func WebOrigin() string {
	origin, _ := types.ResolveWebOrigin()
	return origin
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fail(err)
	}
}
