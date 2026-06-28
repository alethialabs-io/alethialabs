// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

var clusterCmd = &cobra.Command{
	Use:   "cluster",
	Short: "View project cluster information",
	Long:  `List and inspect the Kubernetes clusters provisioned for your projects.`,
}

func init() {
	rootCmd.AddCommand(clusterCmd)
}
