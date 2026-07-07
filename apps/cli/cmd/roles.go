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
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var roles []api.Role
			ui.RunSpinner("Fetching roles...", func() { roles, err = client.ListRoles() })
			if err != nil {
				failf("Failed to list roles: %v", err)
			}
			if len(roles) == 0 {
				ui.Muted("No roles found.")
				return
			}
			_ = ui.ShowTable(roleListColumns, roleRows(roles), "roles")
			return
		}
		if err := runRolesList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list roles: %v", err)
		}
	},
}

var roleListColumns = []string{"Name", "Built-in", "Permissions", "ID"}

// roleRows projects roles into plain table rows; built-ins are flagged with the
// brand marker and permissions render as a count.
func roleRows(roles []api.Role) [][]string {
	rows := make([][]string, len(roles))
	for i, r := range roles {
		rows[i] = []string{r.Name, yesNo(r.IsBuiltin), strconv.Itoa(len(r.PermissionKeys)), r.ID}
	}
	return rows
}

// runRolesList fetches and renders the roles (non-interactive path).
func runRolesList(c apiClient, out io.Writer, format string) error {
	roles, err := c.ListRoles()
	if err != nil {
		return err
	}
	if len(roles) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No roles found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: roleListColumns,
		Rows:    roleRows(roles),
	}, roles)
}

var rolePermissions []string

var rolesCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a custom role",
	Long: `Create a custom role with a set of permissions. Repeat --permission for
multiple keys (each is a resource:action key, e.g. project:deploy). Authoring custom
roles requires an Enterprise license.`,
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runRolesCreate(api.NewClient(token), os.Stdout, args[0], rolePermissions); err != nil {
			failf("Failed to create role: %v", err)
		}
	},
}

// runRolesCreate creates a custom role and confirms it.
func runRolesCreate(c apiClient, out io.Writer, name string, permissionKeys []string) error {
	role, err := c.CreateRole(name, permissionKeys)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Created role %s (%s) with %d permission(s)", role.Name, role.ID, len(role.PermissionKeys))))
	return nil
}

var rolesDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a custom role",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if !confirm("Delete this role?", "Grants referencing it are removed too. Built-in roles cannot be deleted. This cannot be undone.") {
			return
		}
		if err := runRolesDelete(api.NewClient(token), os.Stdout, args[0]); err != nil {
			failf("Failed to delete role: %v", err)
		}
	},
}

// runRolesDelete deletes a custom role and confirms it.
func runRolesDelete(c apiClient, out io.Writer, id string) error {
	if err := c.DeleteRole(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Role deleted"))
	return nil
}

func init() {
	rolesCreateCmd.Flags().StringArrayVar(&rolePermissions, "permission", nil, "Permission key to grant (repeatable, e.g. project:deploy)")
	rolesCmd.AddCommand(rolesListCmd)
	rolesCmd.AddCommand(rolesCreateCmd)
	rolesCmd.AddCommand(rolesDeleteCmd)
	rootCmd.AddCommand(rolesCmd)
}
