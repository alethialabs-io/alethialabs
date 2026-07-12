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

// memberRows projects members into plain table rows. The ID column is included
// because `members remove <member_id>` addresses a member by it.
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
	Use:   "add <email>",
	Short: "Invite a member to the active organization",
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
		if err := runMembersAdd(api.NewClient(token), os.Stdout, orgID, args[0], membersAddRole); err != nil {
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

var membersRemoveCmd = &cobra.Command{
	Use:   "remove <member_id>",
	Short: "Remove a member from the active organization",
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
		if !confirm("Remove this member?", "They will lose access to the organization.") {
			return
		}
		if err := runMembersRemove(api.NewClient(token), os.Stdout, orgID, args[0]); err != nil {
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
	membersCmd.PersistentFlags().String("org", "", "Organization id (defaults to the active org)")
	membersAddCmd.Flags().StringVar(&membersAddRole, "role", "member", "Role for the invited member")
	membersCmd.AddCommand(membersListCmd)
	membersCmd.AddCommand(membersAddCmd)
	membersCmd.AddCommand(membersRemoveCmd)
	rootCmd.AddCommand(membersCmd)
}
