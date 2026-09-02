// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var membersCmd = &cobra.Command{
	Use:     "members",
	Aliases: []string{"member"},
	Short:   "Manage organization members",
	Long:    `List members of the active organization, invite new members, and remove members.`,
}

// currentOrgID resolves the org to operate on: the --org flag if set, otherwise
// the active organization from the CLI config.
//
// `--org` is registered on `members` and `teams` ONLY. Those two address the org in their request
// PATH (`/api/cli/orgs/:id/members`), so a different one can be targeted per invocation; roles,
// grants and sso are scoped by the X-Alethia-Org header the active context sets, and have no such
// flag. access.mdx claimed otherwise until this pass.
func currentOrgID(cmd *cobra.Command) (string, error) {
	if o, _ := cmd.Flags().GetString("org"); o != "" {
		return o, nil
	}
	if o := types.LoadCliConfig().ActiveOrgID; o != "" {
		return o, nil
	}
	return "", fmt.Errorf("no active organization — run `alethia org switch` or pass --org")
}

var membersListCmd = &cobra.Command{
	Use:   "list",
	Short: "List members of the active organization",
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
			var members []api.Member
			ui.RunSpinner("Fetching members...", func() { members, err = client.ListMembers(orgID) })
			if err != nil {
				failf("Failed to list members: %v", err)
			}
			if len(members) == 0 {
				ui.Muted("No members found.")
				return
			}
			_ = ui.ShowTable(memberListColumns, memberRows(members), "members")
			return
		}
		if err := runMembersList(client, os.Stdout, outputFormat(cmd), orgID); err != nil {
			failf("Failed to list members: %v", err)
		}
	},
}

var memberListColumns = []string{"ID", "Email", "Name", "Role", "Status"}

// memberRows projects members into plain table rows. The ID column is for a script that wants the
// member id in `-o json`/`-o csv`; a person never needs to copy it, because `members remove` takes
// `--email` and offers a picker.
func memberRows(members []api.Member) [][]string {
	rows := make([][]string, len(members))
	for i, m := range members {
		rows[i] = []string{m.ID, m.Email, m.Name, m.Role, m.Status}
	}
	return rows
}

// runMembersList fetches and renders the members of an organization
// (non-interactive path).
func runMembersList(c apiClient, out io.Writer, format, orgID string) error {
	members, err := c.ListMembers(orgID)
	if err != nil {
		return err
	}
	if len(members) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No members found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: memberListColumns,
		Rows:    memberRows(members),
	}, members)
}

var membersAddRole string

var membersAddCmd = &cobra.Command{
	Use:   "add [email]",
	Short: "Invite a member to the active organization",
	Long: `Invite someone to the active organization. Pass their email and --role to run without a
terminal; with neither, the form asks for both, offering the org's own roles.`,
	Args: cobra.MaximumNArgs(1),
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

		email := ""
		if len(args) > 0 {
			email = args[0]
		}
		role := membersAddRole
		// Two different questions. The EMAIL has no default, so a missing one must be asked for or
		// refused. The ROLE has one, so a scripted `members add ada@example.com` must keep working —
		// but on a terminal it is worth asking, because `member` is rarely what the inviter meant.
		//
		// `Changed` and not emptiness: `--role ""` is a caller who said something, and the form
		// re-asking it would be the CLI ignoring the flag it advertises.
		if email == "" || (!cmd.Flags().Changed("role") && formAvailable()) {
			// The role LIST is the active org's — `GET /api/cli/roles` reads the X-Alethia-Org
			// header, which `--org` does not change. Offering it for another org would name roles
			// that do not exist where the invitation lands.
			email, role, err = promptMembersAdd(client, email, role, orgID == types.LoadCliConfig().ActiveOrgID)
			if err != nil {
				fail(err)
			}
		}
		if err := runMembersAdd(client, os.Stdout, orgID, email, role); err != nil {
			failf("Failed to invite member: %v", err)
		}
	},
}

// runMembersAdd invites email to the org with the given role.
func runMembersAdd(c apiClient, out io.Writer, orgID, email, role string) error {
	inv, err := c.InviteMember(orgID, email, role)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Invited %s as %s", email, inv.Role)))
	return nil
}

// membersRemoveYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var membersRemoveYes bool

// membersRemoveEmail is the --email selector: name the member to remove by their address instead of
// copying a member id out of `members list`.
var membersRemoveEmail string

var membersRemoveCmd = &cobra.Command{
	Use:   "remove [member_id]",
	Short: "Remove a member from the active organization",
	Long: `Remove a member from the active organization. Pass the member id, or --email to name them
by address; with neither, pick from the org's members.`,
	Args: cobra.MaximumNArgs(1),
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

		id := ""
		if len(args) > 0 {
			id = args[0]
		}
		ref, err := resolveOrgChoice(memberPickSpec, id, membersRemoveEmail, memberChoices(client, orgID))
		if err != nil {
			fail(err)
		}
		// Announced BEFORE the confirmation, not after: "Remove this member?" is not a question
		// anyone can answer about a member the CLI chose and never named.
		announceResolvedChoice(ref.Summary, "Removing")
		if !confirmDestructive(membersRemoveYes, "Remove this member?", "They will lose access to the organization.") {
			return
		}
		if err := runMembersRemove(client, os.Stdout, orgID, ref.ID); err != nil {
			failf("Failed to remove member: %v", err)
		}
	},
}

// runMembersRemove removes a member from the org.
func runMembersRemove(c apiClient, out io.Writer, orgID, memberID string) error {
	if err := c.RemoveMember(orgID, memberID); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Member removed"))
	return nil
}

func init() {
	addYesFlag(membersRemoveCmd, &membersRemoveYes)
	membersCmd.PersistentFlags().String("org", "", "Organization id (defaults to the active org)")
	membersAddCmd.Flags().StringVar(&membersAddRole, "role", "member",
		"Role for the invited member (any of the org's roles)")
	membersRemoveCmd.Flags().StringVar(&membersRemoveEmail, "email", "",
		"Remove the member with this email, instead of naming a member id")
	membersCmd.AddCommand(membersListCmd)
	membersCmd.AddCommand(membersAddCmd)
	membersCmd.AddCommand(membersRemoveCmd)
	rootCmd.AddCommand(membersCmd)
}
