// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/bobikenobi12/bb-thesis-2026/apps/vtx/internal/version"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the vtx CLI version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("vtx v%s\n", version.Version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
