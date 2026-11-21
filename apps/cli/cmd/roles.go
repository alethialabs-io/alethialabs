// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var rolesCmd = &cobra.Command{
	Use:     "roles",
	Aliases: []string{"role"},
	Short:   "Manage RBAC roles",
	Long: `Roles are permission bundles. The four built-in templates (owner, admin,
operator, viewer) are read-only; custom roles are org-scoped and editable. List,
create, and delete the active organization's roles. Custom roles require an
Enterprise license.`,
}

var rolesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List roles (built-in templates + custom roles)",
	Long: `List every role the active organization can bind: the four built-in templates and
its custom roles, each with the number of permissions it carries. Under --output json each
role lists its permission keys.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := runListCommand(cmd, roleListView, client.ListRoles); err != nil {
			fail(err)
		}
	},
}

var roleListColumns = []string{"Name", "Built-in", "Permissions", "ID"}

// roleListView is how `roles list` is drawn.
var roleListView = listView[api.Role]{
	Spinner: "Fetching roles...",
	Title:   "roles",
	Empty:   "No roles found.",
	Columns: roleListColumns,
	Rows:    roleRows,
}

// roleRows projects roles into plain table rows; built-ins are flagged with the
// brand marker and permissions render as a count.
func roleRows(roles []api.Role, outFmt string) [][]string {
	rows := make([][]string, len(roles))
	for i, r := range roles {
		rows[i] = []string{r.Name, ui.Cell(outFmt, ui.WireBool(r.IsBuiltin), ui.YesNo(r.IsBuiltin)), strconv.Itoa(len(r.PermissionKeys)), r.ID}
	}
	return rows
}

// runRolesList fetches and renders the roles (non-interactive path).
func runRolesList(c apiClient, out io.Writer, format string) error {
	roles, err := c.ListRoles()
	if err != nil {
		return governanceError(err)
	}
	return renderList(out, format, roleListView, roles)
}

var rolePermissions []string

var rolesCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a custom role",
	Long: `Create a custom role with a set of permissions. Repeat --permission for
multiple keys (each is a resource:action key, e.g. project:deploy); with no --permission
on a terminal, the keys are offered as a list from the control plane's own catalog.
--dry-run checks the input and creates nothing.

Authoring custom roles requires an Enterprise license.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runRolesCreateCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runRolesCreateCmd is `roles create`: it reads the name and the permission keys, asks for what
// is missing, and creates the role.
func runRolesCreateCmd(cmd *cobra.Command, args []string) error {
	p := resultPrinter(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	name := ""
	if len(args) > 0 {
		name = strings.TrimSpace(args[0])
	}
	if name == "" {
		name, err = promptName("alethia roles create", orgFieldKeyName)
		if err != nil {
			return err
		}
	}
	permissions := rolePermissions
	// A role with no permissions is one the server accepts (`permission_keys` defaults to []),
	// so a scripted caller who omits --permission is not refused. On a terminal it is asked,
	// because a role that grants nothing is almost never what someone meant to create.
	if len(permissions) == 0 && canPromptForm() {
		permissions, err = promptRolePermissions(client, nil)
		if err != nil {
			return err
		}
	}
	return runRolesCreate(client, p, name, permissions, cmdmeta.DryRunRequested(cmd))
}

// roleRequest is the request `roles create` sends, as a dry run reports it.
type roleRequest struct {
	Name           string   `json:"name"`
	PermissionKeys []string `json:"permission_keys"`
}

// runRolesCreate creates a custom role and confirms it.
func runRolesCreate(c apiClient, p *Printer, name string, permissionKeys []string, dryRun bool) error {
	if dryRun {
		keys := append([]string{}, permissionKeys...)
		return printDryRun(p, MutationResult{
			ID: name, Kind: govKindRole, Action: ResultCreated,
			Object: plannedRequest{Request: roleRequest{Name: name, PermissionKeys: keys}},
		}, fmt.Sprintf("Would create role %s with %d permission(s)", name, len(keys)))
	}
	role, err := c.CreateRole(name, permissionKeys)
	if err != nil {
		return err
	}
	if role == nil {
		return errNoRecord("role")
	}
	return printChange(p, MutationResult{ID: role.ID, Kind: govKindRole, Action: ResultCreated, Object: role},
		fmt.Sprintf("Created role %s (%s) with %d permission(s)", role.Name, role.ID, len(role.PermissionKeys)))
}

// rolesDeleteYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var rolesDeleteYes bool

// rolesDeleteName is the --name selector: name the custom role to delete instead of copying a role
// id out of `roles list`.
var rolesDeleteName string

var rolesDeleteCmd = &cobra.Command{
	Use:   "delete [role_id]",
	Short: "Delete a custom role",
	Long: `Delete a custom role. Grants that bind it are removed with it. This cannot be
undone.

Name the role with --name, or pass the role id; with neither on a terminal, pick from the
organization's custom roles. You confirm by typing the role's name. With nobody to ask,
pass --yes. --dry-run names the role that would be deleted and deletes nothing.

The four built-in templates cannot be deleted: they are not offered, and naming one is
refused.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runRolesDeleteCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// errBuiltinRole is the refusal for a delete that names one of the four templates.
func errBuiltinRole(name string) error {
	return refusal(clierr.CodeConflict, "alethia roles list",
		"%s is a built-in role and cannot be deleted; only custom roles can", name)
}

// checkDeletableRole looks a role id up in the organization's roles. A built-in template is
// refused: the control plane's delete skips one and still answers ok, so sending it would report
// a deletion that did not happen. A role the list knows gives the reference its name. An id the
// list does not carry is passed on unchanged, and the control plane answers for it.
func checkDeletableRole(c roleLister, ref orgRef) (orgRef, error) {
	if ref.Name != "" {
		return ref, nil
	}
	roles, err := c.ListRoles()
	if err != nil {
		return ref, err
	}
	for _, r := range roles {
		if r.ID != ref.ID {
			continue
		}
		if r.IsBuiltin {
			return ref, errBuiltinRole(r.Name)
		}
		ref.Name = r.Name
	}
	return ref, nil
}

// runRolesDeleteCmd is `roles delete`: it resolves the role, refuses a built-in one, confirms by
// the role's name, and deletes it.
func runRolesDeleteCmd(cmd *cobra.Command, args []string) error {
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
	ref, err := resolveOrgChoice(deletableRolePickSpec, id, rolesDeleteName, deletableRoleChoices(client))
	if err != nil {
		return err
	}
	if ref, err = checkDeletableRole(client, ref); err != nil {
		return err
	}
	if cmdmeta.DryRunRequested(cmd) {
		return printDryRun(p, removalResult(govKindRole, ref), "Would delete role "+orgRefLabel(ref))
	}
	announceResolvedChoice(ref.Summary, "Deleting")
	ok, err := confirmChangeByName(rolesDeleteYes, "alethia roles delete "+shellQuote(ref.ID),
		"Delete this role?", "Grants referencing it are removed too. This cannot be undone.",
		func() string { return orgRefLabel(ref) })
	if err != nil || !ok {
		return err
	}
	return runRolesDelete(client, p, ref)
}

// runRolesDelete deletes a custom role and confirms it.
func runRolesDelete(c apiClient, p *Printer, ref orgRef) error {
	if err := c.DeleteRole(ref.ID); err != nil {
		return notFoundHint(err, deletableRolePickSpec.ListCmd)
	}
	return printChange(p, removalResult(govKindRole, ref), "Deleted role "+orgRefLabel(ref))
}

func init() {
	addYesFlag(rolesDeleteCmd, &rolesDeleteYes)
	rolesCreateCmd.Flags().StringArrayVar(&rolePermissions, "permission", nil, "Permission key to grant (repeatable, e.g. project:deploy)")
	rolesDeleteCmd.Flags().StringVar(&rolesDeleteName, "name", "",
		"Delete the custom role with this name, instead of naming a role id")
	rolesCmd.AddCommand(rolesListCmd)
	rolesCmd.AddCommand(rolesCreateCmd)
	rolesCmd.AddCommand(rolesDeleteCmd)
	rootCmd.AddCommand(rolesCmd)
}
