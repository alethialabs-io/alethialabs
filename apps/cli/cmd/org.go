// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

var orgCmd = &cobra.Command{
	Use:     "org",
	Aliases: []string{"orgs", "organization", "organizations"},
	Short:   "Manage organizations",
	Long: `List the organizations you belong to and switch the active organization
context. The active org is sent with every request so the control plane scopes
your access — members, teams, projects, runners, and jobs all resolve within it.`,
}

func init() {
	rootCmd.AddCommand(orgCmd)
}
