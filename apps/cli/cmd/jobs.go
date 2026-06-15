// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var jobsCmd = &cobra.Command{
	Use:   "jobs",
	Short: "Manage provisioning jobs",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use `alethia jobs list`, `alethia jobs get <id>`, `alethia jobs logs <id>`, or `alethia jobs cancel <id>`")
	},
}

func init() {
	rootCmd.AddCommand(jobsCmd)
}
