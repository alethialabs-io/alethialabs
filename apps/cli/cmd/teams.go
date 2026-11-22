// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var teamsCmd = &cobra.Command{
	Use:     "teams",
	Aliases: []string{"team"},
	Short:   "Manage organization teams",
	Long: `List, create and delete the teams of the active organization.

A team is a principal: "alethia grants add --principal-type team" binds a role or a
permission to everyone in it. A team is named by its name wherever one is asked for.`,
}

var teamsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List teams in the active organization",
	Long:  `List every team in the active organization with the number of members it has.`,
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		orgID, err := currentOrgID()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := runListCommand(cmd, teamListView, func() ([]api.Team, error) {
			return client.ListTeams(orgID)
		}); err != nil {
			fail(err)
		}
	},
}

var teamListColumns = []string{"ID", "Name", "Members"}

// teamListView is how `teams list` is drawn.
var teamListView = listView[api.Team]{
	Spinner: "Fetching teams...",
	Title:   "teams",
	Empty:   "No teams found. Create one with `alethia teams create`.",
	Columns: teamListColumns,
	Rows:    func(teams []api.Team, _ string) [][]string { return teamRows(teams) },
}

// teamRows projects teams into plain table rows. The ID column is for a script that wants the team
// id in `-o json`/`-o csv`; a person never needs to copy it, because `teams delete` takes `--name`
// and offers a picker.
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
		return governanceError(err)
	}
	return renderList(out, format, teamListView, teams)
}

var teamsCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a team in the active organization",
	Long: `Create a team in the active organization. Pass the name to run without a terminal;
with no name on a terminal, the form asks for one. --dry-run checks the input and creates
nothing.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runTeamsCreateCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runTeamsCreateCmd is `teams create`: it reads the name, asks for it when it is missing, and
// creates the team.
func runTeamsCreateCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	orgID, err := currentOrgID()
	if err != nil {
		return err
	}
	name := ""
	if len(args) > 0 {
		name = strings.TrimSpace(args[0])
	}
	if name == "" {
		name, err = promptName("alethia teams create", orgFieldKeyName)
		if err != nil {
			return err
		}
	}
	return runTeamsCreate(api.NewClient(token), p, orgID, name, cmdmeta.DryRunRequested(cmd))
}

// teamRequest is the request `teams create` sends, as a dry run reports it.
type teamRequest struct {
	Organization string `json:"organization"`
	Name         string `json:"name"`
}

// runTeamsCreate creates a team in the org.
func runTeamsCreate(c apiClient, p *Printer, orgID, name string, dryRun bool) error {
	if dryRun {
		return printDryRun(p, MutationResult{
			ID: name, Kind: govKindTeam, Action: ResultCreated,
			Object: plannedRequest{Request: teamRequest{Organization: orgID, Name: name}},
		}, "Would create team "+name)
	}
	team, err := c.CreateTeam(orgID, name)
	if err != nil {
		return err
	}
	if team == nil {
		return errNoRecord("team")
	}
	return printChange(p, MutationResult{ID: team.ID, Kind: govKindTeam, Action: ResultCreated, Object: team},
		"Created team "+team.Name)
}

// teamsDeleteYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var teamsDeleteYes bool

// teamsDeleteName is the --name selector: name the team to delete instead of copying a team id out
// of `teams list`.
var teamsDeleteName string

var teamsDeleteCmd = &cobra.Command{
	Use:   "delete [team_id]",
	Short: "Delete a team from the active organization",
	Long: `Delete a team from the active organization. Its members stay in the organization
and lose what the team's grants gave them. This cannot be undone.

Name the team with --name, or pass the team id; with neither on a terminal, pick from the
list. You confirm by typing the team's name. With nobody to ask, pass --yes. --dry-run
names the team that would be deleted and deletes nothing.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runTeamsDeleteCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runTeamsDeleteCmd is `teams delete`: it resolves the team, confirms by its name, and deletes it.
func runTeamsDeleteCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	orgID, err := currentOrgID()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	id := ""
	if len(args) > 0 {
		id = args[0]
	}
	choices := teamChoices(client, orgID)
	ref, err := resolveOrgChoice(teamPickSpec, id, teamsDeleteName, choices)
	if err != nil {
		return err
	}
	if cmdmeta.DryRunRequested(cmd) {
		return printDryRun(p, removalResult(govKindTeam, ref), "Would delete team "+orgRefLabel(ref))
	}
	announceResolvedChoice(ref.Summary, "Deleting")
	ok, err := confirmChangeByName(teamsDeleteYes, "alethia teams delete "+shellQuote(ref.ID),
		"Delete this team?", "Members will lose their team grants. This cannot be undone.",
		func() string { return learnOrgRefName(&ref, choices) })
	if err != nil || !ok {
		return err
	}
	return runTeamsDelete(client, p, orgID, ref)
}

// runTeamsDelete deletes a team from the org.
func runTeamsDelete(c apiClient, p *Printer, orgID string, ref orgRef) error {
	if err := c.DeleteTeam(orgID, ref.ID); err != nil {
		return notFoundHint(err, teamPickSpec.ListCmd)
	}
	return printChange(p, removalResult(govKindTeam, ref), "Deleted team "+orgRefLabel(ref))
}

func init() {
	addYesFlag(teamsDeleteCmd, &teamsDeleteYes)
	// No `--org` here — it is a ROOT persistent flag now (shell_fields.go, #3817). See the note in
	// members.go's init for why a second registration on the group would be worse than none.
	teamsDeleteCmd.Flags().StringVar(&teamsDeleteName, "name", "",
		"Delete the team with this name, instead of naming a team id")
	teamsCmd.AddCommand(teamsListCmd)
	teamsCmd.AddCommand(teamsCreateCmd)
	teamsCmd.AddCommand(teamsDeleteCmd)
	rootCmd.AddCommand(teamsCmd)
}
