// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show the current user and active organization",
	Long: `Resolve and display who you are signed in as: the authenticated user, the
active organization context, your role in it, the org's plan, and its default
runner. Use --output json for scripting.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runWhoami(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to resolve identity: %v", err)
		}
	},
}

// runWhoami fetches the resolved identity and renders it. json emits the whole
// object; table/csv render a Field/Value view.
func runWhoami(c apiClient, out io.Writer, format string) error {
	me, err := c.Whoami()
	if err != nil {
		return err
	}
	rows := [][]string{
		{"User", me.User.Email},
	}
	if me.User.Name != "" {
		rows = append(rows, []string{"Name", me.User.Name})
	}
	if me.ActiveOrg != nil {
		rows = append(rows,
			[]string{"Organization", me.ActiveOrg.Name},
			[]string{"Slug", me.ActiveOrg.Slug},
			[]string{"Role", me.ActiveOrg.Role},
			[]string{"Plan", me.ActiveOrg.Plan},
		)
	} else {
		rows = append(rows, []string{"Organization", ui.SymbolDash})
	}
	if me.DefaultRunner != nil {
		rows = append(rows, []string{"Default runner", me.DefaultRunner.Name})
	}

	return ui.RenderCard(out, format, "alethia · whoami", rows, me)
}

func init() {
	rootCmd.AddCommand(whoamiCmd)
}
