// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/spf13/cobra"
)

var tendrilCmd = &cobra.Command{
	Use:   "tendril",
	Short: "Manage tendrils (provisioning workers)",
	Long: `Tendrils are provisioning workers that execute infrastructure jobs.

Use the subcommands to list, deploy, destroy, or remove tendrils.`,
}

func init() {
	rootCmd.AddCommand(tendrilCmd)
}
