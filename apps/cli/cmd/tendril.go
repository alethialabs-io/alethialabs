// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/spf13/cobra"
)

var tendrilCmd = &cobra.Command{
	Use:   "runner",
	Short: "Manage runners (provisioning workers)",
	Long: `Runners are provisioning workers that execute infrastructure jobs.

Use the subcommands to list, deploy, destroy, or remove runners.`,
}

func init() {
	rootCmd.AddCommand(tendrilCmd)
}
