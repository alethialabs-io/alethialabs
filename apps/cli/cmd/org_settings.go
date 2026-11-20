// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var orgSettingsCmd = &cobra.Command{
	Use:   "settings",
	Short: "Show the active organization's general settings",
	Long: `Show the active organization's name, slug, description, default region, default
environment and Terraform version. Read-only: the settings are changed in the console.

Under --output json the whole record is printed, or null on a deployment with no
organizations.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runOrgSettings(api.NewClient(token), printer.Out, outputFormat(cmd)); err != nil {
			fail(err)
		}
	},
}

// runOrgSettings fetches and renders the active org's general settings. json emits the whole
// object (or null in community mode); table/csv render the field/value card.
func runOrgSettings(c apiClient, out io.Writer, format string) error {
	s, err := c.GetOrgSettings()
	if err != nil {
		return governanceError(err)
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, s)
	}
	if s == nil {
		// Nothing to print: the absence is said on stderr, and csv gets no rows.
		printer.Note("Not in an organization (community mode).")
		return nil
	}
	rows := [][]string{
		{"name", s.Name},
		{"slug", s.Slug},
		{"description", ui.OrDash(s.Description)},
		{"region", s.Region},
		{"default env", s.DefaultEnv},
		{"terraform", s.TerraformVersion},
	}
	return ui.RenderCard(out, format, "alethia · org settings", rows, s)
}

func init() {
	orgCmd.AddCommand(orgSettingsCmd)
}
