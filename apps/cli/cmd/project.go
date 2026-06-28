// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/spf13/cobra"
)

var projectCmd = &cobra.Command{
	Use:   "project",
	Short: "Manage projects (infrastructure configurations)",
	Long: `Projects are infrastructure configurations.

Use the subcommands to list, view, plan, apply, or destroy project infrastructure.`,
}

func init() {
	rootCmd.AddCommand(projectCmd)
}
