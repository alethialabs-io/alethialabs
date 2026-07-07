// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/spf13/cobra"
)

var runnerCmd = &cobra.Command{
	Use:   "runner",
	Short: "Manage runners",
	Long: `Runners execute infrastructure jobs.

Use the subcommands to list, deploy, destroy, or remove runners.`,
}

func init() {
	rootCmd.AddCommand(runnerCmd)
}
