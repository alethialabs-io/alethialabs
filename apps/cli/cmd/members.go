// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var membersCmd = &cobra.Command{
	Use:     "members",
	Aliases: []string{"member"},
	Short:   "Manage organization members",
	Long: `List the members of the active organization, invite someone to it, and remove a
member from it.

A member is named by email wherever one is asked for, so no command here needs an id
copied out of another command's output.`,
}

var membersListCmd = &cobra.Command{
	Use:   "list",
	Short: "List members of the active organization",
	Long: `List everyone in the active organization with their role and status. An invitation
that has not been accepted yet is listed with the status the control plane gives it.`,
	Args: cobra.NoArgs,
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
		if err := runListCommand(cmd, memberListView, func() ([]api.Member, error) {
			return client.ListMembers(orgID)
		}); err != nil {
			fail(err)
		}
	},
}

var memberListColumns = []string{"ID", "Email", "Name", "Role", "Status"}

// memberListView is how `members list` is drawn.
var memberListView = listView[api.Member]{
	Spinner: "Fetching members...",
	Title:   "members",
	Empty:   "No members found. Invite one with `alethia members add`.",
	Columns: memberListColumns,
	Rows:    func(members []api.Member, _ string) [][]string { return memberRows(members) },
}

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
		return governanceError(err)
	}
	return renderList(out, format, memberListView, members)
}

var membersAddRole string

var membersAddCmd = &cobra.Command{
	Use:     "add [email]",
	Aliases: []string{"invite"},
	Short:   "Invite a member to the active organization",
	Long: `Invite someone to the active organization. They receive an invitation at the address
you give and become a member when they accept it.

Pass the email and --role to run without a terminal. With no email on a terminal the form
asks for both, offering the organization's own roles. --dry-run checks the input and sends
no invitation.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runMembersAddCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runMembersAddCmd is `members add`: it reads the email and the role from the command line, asks
// for what is missing, and sends the invitation.
func runMembersAddCmd(cmd *cobra.Command, args []string) error {
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

	email := ""
	if len(args) > 0 {
		email = strings.TrimSpace(args[0])
	}
	role := membersAddRole
	// Two different questions. The EMAIL has no default, so a missing one must be asked for or
	// refused. The ROLE has one, so a scripted `members add ada@example.com` must keep working —
	// but on a terminal it is worth asking, because `member` is rarely what the inviter meant.
	//
	// `Changed` and not emptiness: `--role ""` is a caller who said something, and the form
	// re-asking it would be the CLI ignoring the flag it advertises.
	if email == "" || (!cmd.Flags().Changed("role") && canPromptForm()) {
		// The role LIST comes from `GET /api/cli/roles`, which is scoped by the X-Alethia-Org
		// header. That header used to follow the active context while `--org` moved only the
		// request PATH, so a cross-org invitation was offered the WRONG org's roles and the
		// list had to be withheld. Since #3817 both come from one value (currentOrgID and
		// setAuthHeaders read the same override), so the roles offered are always the ones
		// that exist where the invitation lands.
		email, role, err = promptMembersAdd(client, email, role, true)
		if err != nil {
			return err
		}
	}
	return runMembersAdd(client, p, orgID, email, role, cmdmeta.DryRunRequested(cmd))
}

// inviteRequest is the request `members add` sends, as a dry run reports it.
type inviteRequest struct {
	Organization string `json:"organization"`
	Email        string `json:"email"`
	Role         string `json:"role"`
}

// runMembersAdd invites email to the org with the given role.
func runMembersAdd(c apiClient, p *Printer, orgID, email, role string, dryRun bool) error {
	if err := requireEmail(email); err != nil {
		return refusal(clierr.CodeValidationFailed, "alethia members add ada@example.com --role member", "%v", err)
	}
	if dryRun {
		return printDryRun(p, MutationResult{
			ID: email, Kind: govKindInvitation, Action: ResultCreated,
			Object: plannedRequest{Request: inviteRequest{Organization: orgID, Email: email, Role: role}},
		}, fmt.Sprintf("Would invite %s as %s", email, role))
	}
	inv, err := c.InviteMember(orgID, email, role)
	if err != nil {
		return err
	}
	if inv == nil {
		return errNoRecord("invitation")
	}
	return printChange(p, MutationResult{ID: inv.ID, Kind: govKindInvitation, Action: ResultCreated, Object: inv},
		fmt.Sprintf("Invited %s as %s", email, inv.Role))
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
	Long: `Remove a member from the active organization. They lose access to everything in it
at once.

Name the member with --email, or pass the member id; with neither on a terminal, pick from
the list. You confirm by typing the member's email. With nobody to ask, pass --yes.
--dry-run names the member that would be removed and removes nobody.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runMembersRemoveCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runMembersRemoveCmd is `members remove`: it resolves the member, confirms by their email, and
// removes them.
func runMembersRemoveCmd(cmd *cobra.Command, args []string) error {
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
	choices := memberChoices(client, orgID)
	ref, err := resolveOrgChoice(memberPickSpec, id, membersRemoveEmail, choices)
	if err != nil {
		return err
	}
	if cmdmeta.DryRunRequested(cmd) {
		return printDryRun(p, removalResult(govKindMember, ref), "Would remove member "+orgRefLabel(ref))
	}
	// Announced BEFORE the confirmation, not after: "Remove this member?" is not a question
	// anyone can answer about a member the CLI chose and never named.
	announceResolvedChoice(ref.Summary, "Removing")
	ok, err := confirmChangeByName(membersRemoveYes, "alethia members remove "+shellQuote(ref.ID),
		"Remove this member?", "They lose access to the organization.",
		func() string { return learnOrgRefName(&ref, choices) })
	if err != nil || !ok {
		return err
	}
	return runMembersRemove(client, p, orgID, ref)
}

// removedRecord is the `object` of a delete result: the id that went, and its name when the CLI
// looked it up.
type removedRecord struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

// orgRefLabel renders a resolved entity for a sentence: its name when the CLI holds one, else its
// id.
func orgRefLabel(ref orgRef) string {
	if ref.Name != "" {
		return ref.Name
	}
	return ref.ID
}

// learnOrgRefName returns what a person types to confirm removing ref, and records the name on ref
// when the lookup found one, so the result that follows carries it.
func learnOrgRefName(ref *orgRef, list func() ([]orgChoice, error)) string {
	name := orgRefName(*ref, list)
	if name != ref.ID {
		ref.Name = name
	}
	return name
}

// removalResult is the result of deleting ref, a record of the given kind.
func removalResult(kind string, ref orgRef) MutationResult {
	return MutationResult{
		ID: ref.ID, Kind: kind, Action: ResultDeleted,
		Object: removedRecord{ID: ref.ID, Name: ref.Name},
	}
}

// runMembersRemove removes a member from the org.
func runMembersRemove(c apiClient, p *Printer, orgID string, ref orgRef) error {
	if err := c.RemoveMember(orgID, ref.ID); err != nil {
		return notFoundHint(err, memberPickSpec.ListCmd)
	}
	return printChange(p, removalResult(govKindMember, ref), "Removed member "+orgRefLabel(ref))
}

func init() {
	addYesFlag(membersRemoveCmd, &membersRemoveYes)
	// No `--org` here. It is a ROOT persistent flag (shell_fields.go, #3817) — registering a second
	// one on this group would shadow it, because cobra resolves to the nearest definition, and
	// `members` would then read a different variable from every other command in the tree.
	membersAddCmd.Flags().StringVar(&membersAddRole, "role", "member",
		"Role for the invited member (any of the org's roles)")
	membersRemoveCmd.Flags().StringVar(&membersRemoveEmail, "email", "",
		"Remove the member with this email, instead of naming a member id")
	membersCmd.AddCommand(membersListCmd)
	membersCmd.AddCommand(membersAddCmd)
	membersCmd.AddCommand(membersRemoveCmd)
	rootCmd.AddCommand(membersCmd)
}
