// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/spf13/cobra"
)

var specCmd = &cobra.Command{
	Use:   "spec",
	Short: "Manage specs (infrastructure configurations)",
	Long: `Specs are infrastructure configurations for projects.

Use the subcommands to list, view, plan, apply, or destroy spec infrastructure.`,
}

func init() {
	rootCmd.AddCommand(specCmd)
}
