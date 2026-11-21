// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var orgListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the organizations you belong to",
	Long: `List every organization you belong to, with your role and its plan. The Active
column marks the one your commands act in; change it with "alethia org switch".`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := runListCommand(cmd, orgListView, client.ListOrgs); err != nil {
			fail(err)
		}
	},
}

var orgListColumns = []string{"Name", "Slug", "Role", "Plan", "Active"}

// orgListView is how `org list` is drawn.
var orgListView = listView[api.OrgSummary]{
	Spinner: "Fetching organizations...",
	Title:   "organizations",
	Empty:   "No organizations found. Create one in the console, or ask an owner to invite you.",
	Columns: orgListColumns,
	Rows:    orgRows,
}

// orgRows projects organizations into plain table rows; the active org is flagged
// with the brand's default marker.
func orgRows(orgs []api.OrgSummary, outFmt string) [][]string {
	rows := make([][]string, len(orgs))
	for i, o := range orgs {
		rows[i] = []string{o.Name, o.Slug, o.Role, o.Plan, ui.Cell(outFmt, ui.WireBool(o.IsActive), ui.DefaultCell(o.IsActive))}
	}
	return rows
}

// runOrgList fetches and renders the caller's organizations (non-interactive
// path: static table / json / csv).
func runOrgList(c apiClient, out io.Writer, format string) error {
	orgs, err := c.ListOrgs()
	if err != nil {
		return governanceError(err)
	}
	return renderList(out, format, orgListView, orgs)
}

func init() {
	orgCmd.AddCommand(orgListCmd)
}
