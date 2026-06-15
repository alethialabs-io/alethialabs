// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var vineyardCmd = &cobra.Command{
	Use:   "vineyard",
	Short: "Manage vineyards (workspaces)",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `alethia vineyard list`, `alethia vineyard create <name>` or `alethia vineyard delete <name>`")
	},
}

func init() {
	rootCmd.AddCommand(vineyardCmd)
}
