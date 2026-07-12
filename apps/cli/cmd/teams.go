// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var teamsCmd = &cobra.Command{
	Use:     "teams",
	Aliases: []string{"team"},
	Short:   "Manage organization teams",
	Long:    `List, create, and delete teams within the active organization.`,
}

var teamsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List teams in the active organization",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		orgID, err := currentOrgID(cmd)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var teams []api.Team
			ui.RunSpinner("Fetching teams...", func() { teams, err = client.ListTeams(orgID) })
			if err != nil {
				failf("Failed to list teams: %v", err)
			}
			if len(teams) == 0 {
				ui.Muted("No teams found.")
				return
			}
			_ = ui.ShowTable(teamListColumns, teamRows(teams), "teams")
			return
		}
		if err := runTeamsList(client, os.Stdout, outputFormat(cmd), orgID); err != nil {
			failf("Failed to list teams: %v", err)
		}
	},
}

var teamListColumns = []string{"ID", "Name", "Members"}

// teamRows projects teams into plain table rows. The ID column is included
// because `teams delete <team_id>` addresses a team by it.
func teamRows(teams []api.Team) [][]string {
	rows := make([][]string, len(teams))
	for i, t := range teams {
		rows[i] = []string{t.ID, t.Name, strconv.Itoa(t.MemberCount)}
	}
	return rows
}

// runTeamsList fetches and renders the teams of an organization
// (non-interactive path).
func runTeamsList(c apiClient, out io.Writer, format, orgID string) error {
	teams, err := c.ListTeams(orgID)
	if err != nil {
		return err
	}
	if len(teams) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No teams found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: teamListColumns,
		Rows:    teamRows(teams),
	}, teams)
}

var teamsCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a team in the active organization",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		orgID, err := currentOrgID(cmd)
		if err != nil {
			fail(err)
		}
		if err := runTeamsCreate(api.NewClient(token), os.Stdout, orgID, args[0]); err != nil {
			failf("Failed to create team: %v", err)
		}
	},
}

// runTeamsCreate creates a team in the org.
func runTeamsCreate(c apiClient, out io.Writer, orgID, name string) error {
	team, err := c.CreateTeam(orgID, name)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Created team "+team.Name))
	return nil
}

var teamsDeleteCmd = &cobra.Command{
	Use:   "delete <team_id>",
	Short: "Delete a team from the active organization",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		orgID, err := currentOrgID(cmd)
		if err != nil {
			fail(err)
		}
		if !confirm("Delete this team?", "Members will lose their team grants. This cannot be undone.") {
			return
		}
		if err := runTeamsDelete(api.NewClient(token), os.Stdout, orgID, args[0]); err != nil {
			failf("Failed to delete team: %v", err)
		}
	},
}

// runTeamsDelete deletes a team from the org.
func runTeamsDelete(c apiClient, out io.Writer, orgID, teamID string) error {
	if err := c.DeleteTeam(orgID, teamID); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Team deleted"))
	return nil
}

func init() {
	teamsCmd.PersistentFlags().String("org", "", "Organization id (defaults to the active org)")
	teamsCmd.AddCommand(teamsListCmd)
	teamsCmd.AddCommand(teamsCreateCmd)
	teamsCmd.AddCommand(teamsDeleteCmd)
	rootCmd.AddCommand(teamsCmd)
}
