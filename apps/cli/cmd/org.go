// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

var orgCmd = &cobra.Command{
	Use:     "org",
	Aliases: []string{"orgs", "organization", "organizations"},
	Short:   "List your organizations and choose the active one",
	Long: `List the organizations you belong to, read the active one's settings, and switch
the active organization.

The active organization is sent with every request, so members, teams, projects, runners
and jobs all resolve inside it. Pass --org to any command to act in another organization
for that one invocation without switching.`,
}

func init() {
	rootCmd.AddCommand(orgCmd)
}
