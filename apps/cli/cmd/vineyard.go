// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var vineyardCmd = &cobra.Command{
	Use:   "zone",
	Short: "Manage zones (workspaces)",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `alethia zone list`, `alethia zone create <name>` or `alethia zone delete <name>`")
	},
}

func init() {
	rootCmd.AddCommand(vineyardCmd)
}
