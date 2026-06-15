// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the alethia CLI version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("alethia v%s\n", version.Version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
