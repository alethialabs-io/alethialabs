// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

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
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var grants []api.Grant
			ui.RunSpinner("Fetching grants...", func() { grants, err = client.ListGrants() })
			if err != nil {
				failf("Failed to list grants: %v", err)
			}
			if len(grants) == 0 {
				ui.Muted("No access grants found.")
				return
			}
			_ = ui.ShowTable(grantListColumns, grantRows(grants), "grants")
			return
		}
		if err := runGrantsList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list grants: %v", err)
		}
	},
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
func grantRows(grants []api.Grant) [][]string {
	rows := make([][]string, len(grants))
	for i, g := range grants {
		rows[i] = []string{
			fmt.Sprintf("%s %s", g.PrincipalType, g.PrincipalID),
			g.Effect,
			orDash(g.Role),
			orDash(g.PermissionKey),
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
		return err
	}
	if len(grants) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No access grants found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: grantListColumns,
		Rows:    grantRows(grants),
	}, grants)
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
an org-wide grant. Requires an Enterprise license.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if (grantRoleID == "") == (grantPermission == "") {
			failf("Provide exactly one of --role or --permission")
		}
		params := api.AddGrantParams{
			PrincipalType: grantPrincipalType,
			PrincipalID:   grantPrincipalID,
			Effect:        grantEffect,
			RoleID:        grantRoleID,
			PermissionKey: grantPermission,
			ResourceType:  grantResourceType,
			ResourceID:    grantResourceID,
		}
		if err := runGrantsAdd(api.NewClient(token), os.Stdout, params); err != nil {
			failf("Failed to add grant: %v", err)
		}
	},
}

// runGrantsAdd assigns a grant and confirms it.
func runGrantsAdd(c apiClient, out io.Writer, params api.AddGrantParams) error {
	grant, err := c.AddGrant(params)
	if err != nil {
		return err
	}
	bound := grant.PermissionKey
	if bound == "" {
		bound = grant.Role
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Granted %s %s on %s (%s)", grant.Effect, bound, grantScope(*grant), grant.ID)))
	return nil
}

var grantsRemoveCmd = &cobra.Command{
	Use:   "remove <id>",
	Short: "Revoke an access grant",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if !confirm("Revoke this grant?", "The principal loses this access. This cannot be undone.") {
			return
		}
		if err := runGrantsRemove(api.NewClient(token), os.Stdout, args[0]); err != nil {
			failf("Failed to remove grant: %v", err)
		}
	},
}

// runGrantsRemove revokes a grant and confirms it.
func runGrantsRemove(c apiClient, out io.Writer, id string) error {
	if err := c.RemoveGrant(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Grant revoked"))
	return nil
}

func init() {
	grantsAddCmd.Flags().StringVar(&grantPrincipalType, "principal-type", "user", "Principal kind (user or team)")
	grantsAddCmd.Flags().StringVar(&grantPrincipalID, "principal", "", "Principal id (user or team id)")
	grantsAddCmd.Flags().StringVar(&grantEffect, "effect", "allow", "Effect (allow or deny)")
	grantsAddCmd.Flags().StringVar(&grantRoleID, "role", "", "Role id to bind (XOR --permission)")
	grantsAddCmd.Flags().StringVar(&grantPermission, "permission", "", "Single permission key to bind (XOR --role)")
	grantsAddCmd.Flags().StringVar(&grantResourceType, "resource-type", "org", "Resource type to scope to (project, runner, cloud_identity, org)")
	grantsAddCmd.Flags().StringVar(&grantResourceID, "resource", "", "Resource id to scope to (omit for org-wide)")
	_ = grantsAddCmd.MarkFlagRequired("principal")

	grantsCmd.AddCommand(grantsListCmd)
	grantsCmd.AddCommand(grantsAddCmd)
	grantsCmd.AddCommand(grantsRemoveCmd)
	rootCmd.AddCommand(grantsCmd)
}
