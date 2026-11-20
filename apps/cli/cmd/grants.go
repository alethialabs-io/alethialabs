// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var grantsCmd = &cobra.Command{
	Use:     "grants",
	Aliases: []string{"grant", "access"},
	Short:   "Manage access grants",
	Long: `A grant binds a principal (a user or a team) to a role OR a single permission
on a resource, as an allow or an explicit deny (deny wins). Omit a resource for an
org-wide grant. List, add, and remove the active organization's grants. Managing
access requires an Enterprise license.`,
}

var grantsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List access grants",
	Long: `List every access grant in the active organization: who it is for, whether it
allows or denies, the role or permission it binds, and the resource it is scoped to.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := runListCommand(cmd, grantListView, client.ListGrants); err != nil {
			fail(err)
		}
	},
}

// grantListView is how `grants list` is drawn.
var grantListView = listView[api.Grant]{
	Spinner: "Fetching grants...",
	Title:   "grants",
	Empty:   "No access grants found. Add one with `alethia grants add`.",
	Columns: grantListColumns,
	Rows:    grantRows,
}

var grantListColumns = []string{"Principal", "Effect", "Role", "Permission", "Resource", "ID"}

// grantScope renders a grant's resource scope: "type (id)" when scoped, else "type".
func grantScope(g api.Grant) string {
	if g.ResourceID != "" {
		return fmt.Sprintf("%s (%s)", g.ResourceType, g.ResourceID)
	}
	return g.ResourceType
}

// grantRows projects grants into plain table rows. The principal is rendered as
// "type id"; role and permission fall back to a dash (a grant carries exactly one).
func grantRows(grants []api.Grant, outFmt string) [][]string {
	rows := make([][]string, len(grants))
	for i, g := range grants {
		rows[i] = []string{
			fmt.Sprintf("%s %s", g.PrincipalType, g.PrincipalID),
			g.Effect,
			ui.Cell(outFmt, g.Role, ui.OrDash(g.Role)),
			ui.Cell(outFmt, g.PermissionKey, ui.OrDash(g.PermissionKey)),
			grantScope(g),
			g.ID,
		}
	}
	return rows
}

// runGrantsList fetches and renders the access grants (non-interactive path).
func runGrantsList(c apiClient, out io.Writer, format string) error {
	grants, err := c.ListGrants()
	if err != nil {
		return governanceError(err)
	}
	return renderList(out, format, grantListView, grants)
}

var (
	grantPrincipalType string
	grantPrincipalID   string
	grantEffect        string
	grantRoleID        string
	grantPermission    string
	grantResourceType  string
	grantResourceID    string
)

var grantsAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Assign an access grant",
	Long: `Assign an access grant. Bind a principal to EXACTLY one of a role (--role) or
a single permission (--permission), with an allow or deny effect. Omit --resource for
an org-wide grant. Requires an Enterprise license.

--principal takes an email (or a team name) as readily as an id, and --role takes a role
name; both are looked up against the active org. With no --principal on a terminal, the
whole grant is asked for. --dry-run resolves every name, prints the grant that would be
written, and writes nothing.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runGrantsAddCmd(cmd); err != nil {
			fail(governanceError(err))
		}
	},
}

// runGrantsAddCmd is `grants add`: it reads the grant from the flags or the form, checks it,
// resolves the principal and the role to ids, and writes the grant.
func runGrantsAddCmd(cmd *cobra.Command) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	// Resolved but NOT required. A grant whose principal and role are already ids needs no
	// member list, so an org that cannot be resolved must not fail a command that never asks
	// for one; the error is carried and reported only by a lookup that actually needs it.
	orgID, orgErr := currentOrgID()

	answers := grantsAddAnswers{
		PrincipalType: grantPrincipalType,
		Principal:     grantPrincipalID,
		Effect:        grantEffect,
		RoleID:        grantRoleID,
		Permission:    grantPermission,
		ResourceType:  grantResourceType,
		ResourceID:    grantResourceID,
	}
	if answers.Principal == "" {
		if orgErr != nil {
			return orgErr
		}
		answers, err = promptGrantsAdd(client, orgID, answers)
		if err != nil {
			return err
		}
	}

	// The closed sets are checked AFTER the form, not instead of it: the form can only write
	// back a value it was given, so this arm exists for the flags — and checking both through
	// one gate is what keeps the two paths from diverging.
	principalType, err := canonicalOneOf("principal-type", answers.PrincipalType, grantPrincipalTypes)
	if err != nil {
		return err
	}
	effect, err := canonicalOneOf("effect", answers.Effect, grantEffects)
	if err != nil {
		return err
	}
	if (answers.RoleID == "") == (answers.Permission == "") {
		return refusal(clierr.CodeInvalidUsage,
			"alethia grants add --principal ada@example.com --role viewer",
			"provide exactly one of --role or --permission")
	}
	// `--resource` under the `org` kind names a scope that cannot exist. The control plane
	// computes `orgWide = resourceId === null || resourceType === "org"`
	// (apps/console/lib/authz/fga-tuples.ts) BEFORE it expands a single tuple, so the id is
	// written to the grant row and then ignored: the grant covers the whole organization while
	// the command line reads as one project. That is the silent class this command's form was
	// rebuilt to close (#4452), and it is the same defect whichever path reaches it — the more
	// so because `org` is the DEFAULT, so forgetting --resource-type is how you land here.
	if answers.ResourceID != "" && answers.ResourceType == grantResourceTypeOrg {
		return refusal(clierr.CodeInvalidUsage, "",
			"--resource %s is not meaningful with --resource-type org: an org grant is org-wide, "+
				"so the id would be stored and then ignored. Drop --resource, or name the kind the "+
				"resource is (project, runner, cloud_identity).", answers.ResourceID)
	}

	principals := func() ([]orgChoice, error) {
		if orgErr != nil {
			return nil, orgErr
		}
		return grantPrincipalChoices(client, orgID, answers.PrincipalType)()
	}
	principal, err := resolveByNameOrID(grantPrincipalPickSpec, answers.Principal, principals)
	if err != nil {
		return err
	}
	boundRole, err := resolveByNameOrID(grantRolePickSpec, answers.RoleID, bindableRoleChoices(client))
	if err != nil {
		return err
	}

	return runGrantsAdd(client, p, api.AddGrantParams{
		PrincipalType: principalType,
		PrincipalID:   principal.ID,
		Effect:        effect,
		RoleID:        boundRole.ID,
		PermissionKey: answers.Permission,
		ResourceType:  answers.ResourceType,
		ResourceID:    answers.ResourceID,
	}, cmdmeta.DryRunRequested(cmd))
}

// grantRequest is the request `grants add` sends, as a dry run reports it. The principal and the
// role are the ids the names resolved to.
type grantRequest struct {
	PrincipalType string `json:"principal_type"`
	PrincipalID   string `json:"principal_id"`
	Effect        string `json:"effect"`
	RoleID        string `json:"role_id,omitempty"`
	PermissionKey string `json:"permission_key,omitempty"`
	ResourceType  string `json:"resource_type"`
	ResourceID    string `json:"resource_id,omitempty"`
}

// runGrantsAdd assigns a grant and confirms it.
func runGrantsAdd(c apiClient, p *Printer, params api.AddGrantParams, dryRun bool) error {
	if dryRun {
		bound := params.PermissionKey
		if bound == "" {
			bound = "role " + params.RoleID
		}
		return printDryRun(p, MutationResult{
			Kind: govKindGrant, Action: ResultCreated,
			Object: plannedRequest{Request: grantRequest{
				PrincipalType: params.PrincipalType, PrincipalID: params.PrincipalID, Effect: params.Effect,
				RoleID: params.RoleID, PermissionKey: params.PermissionKey,
				ResourceType: params.ResourceType, ResourceID: params.ResourceID,
			}},
		}, fmt.Sprintf("Would grant %s %s to %s %s", params.Effect, bound, params.PrincipalType, params.PrincipalID))
	}
	grant, err := c.AddGrant(params)
	if err != nil {
		return err
	}
	if grant == nil {
		return errNoRecord("grant")
	}
	bound := grant.PermissionKey
	if bound == "" {
		bound = grant.Role
	}
	return printChange(p, MutationResult{ID: grant.ID, Kind: govKindGrant, Action: ResultCreated, Object: grant},
		fmt.Sprintf("Granted %s %s on %s (%s)", grant.Effect, bound, grantScope(*grant), grant.ID))
}

// grantsRemoveYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var grantsRemoveYes bool

var grantsRemoveCmd = &cobra.Command{
	Use:   "remove [grant_id]",
	Short: "Revoke an access grant",
	Long: `Revoke an access grant. The principal loses what it gave at once. This cannot be
undone; assign the grant again to restore it.

Pass the grant id, or pick one from the organization's grants on a terminal. A grant has
no name — it IS the binding — so the picker is the only way to name one without its id.
The command asks before it revokes; with nobody to ask, pass --yes. --dry-run names the
grant that would be revoked and revokes nothing.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runGrantsRemoveCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runGrantsRemoveCmd is `grants remove`: it resolves the grant, confirms, and revokes it.
func runGrantsRemoveCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	id := ""
	if len(args) > 0 {
		id = args[0]
	}
	ref, err := resolveOrgChoice(grantPickSpec, id, "", grantChoices(client))
	if err != nil {
		return err
	}
	if cmdmeta.DryRunRequested(cmd) {
		return printDryRun(p, removalResult(govKindGrant, ref), "Would revoke grant "+ref.ID)
	}
	announceResolvedChoice(ref.Summary, "Revoking")
	ok, err := confirmChange(grantsRemoveYes, "alethia grants remove "+shellQuote(ref.ID),
		"Revoke this grant?", "The principal loses this access. This cannot be undone.")
	if err != nil || !ok {
		return err
	}
	return runGrantsRemove(client, p, ref)
}

// runGrantsRemove revokes a grant and confirms it.
func runGrantsRemove(c apiClient, p *Printer, ref orgRef) error {
	if err := c.RemoveGrant(ref.ID); err != nil {
		return notFoundHint(err, grantPickSpec.ListCmd)
	}
	return printChange(p, removalResult(govKindGrant, ref), "Revoked grant "+ref.ID)
}

func init() {
	addYesFlag(grantsRemoveCmd, &grantsRemoveYes)
	grantsAddCmd.Flags().StringVar(&grantPrincipalType, "principal-type", "user", "Principal kind (user or team)")
	grantsAddCmd.Flags().StringVar(&grantPrincipalID, "principal", "", "Principal — an email, a team name, or the id itself")
	grantsAddCmd.Flags().StringVar(&grantEffect, "effect", "allow", "Effect (allow or deny)")
	grantsAddCmd.Flags().StringVar(&grantRoleID, "role", "", "Role to bind, by name or id (XOR --permission)")
	grantsAddCmd.Flags().StringVar(&grantPermission, "permission", "", "Single permission key to bind (XOR --role)")
	grantsAddCmd.Flags().StringVar(&grantResourceType, "resource-type", "org", "Resource type to scope to (project, runner, cloud_identity, org)")
	grantsAddCmd.Flags().StringVar(&grantResourceID, "resource", "", "Resource id to scope to (omit for org-wide)")
	// --principal is deliberately NOT MarkFlagRequired any more: cobra enforces that before Run,
	// which made the interactive form unreachable — the command died before it could ask.

	grantsCmd.AddCommand(grantsListCmd)
	grantsCmd.AddCommand(grantsAddCmd)
	grantsCmd.AddCommand(grantsRemoveCmd)
	rootCmd.AddCommand(grantsCmd)
}
