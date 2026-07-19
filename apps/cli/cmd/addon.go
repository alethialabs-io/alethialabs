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

var addonCmd = &cobra.Command{
	Use:     "addon",
	Aliases: []string{"addons"},
	Short:   "Inspect a project's installed add-ons",
	Long: `Add-ons are the marketplace OSS Helm charts (observability, databases, caches, …)
installed into an environment via ArgoCD. List the add-ons installed in an environment (defaults
to the project's default environment; pass --env for another).`,
}

var addonListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the add-ons installed in a project environment",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var view *api.ProjectAddons
			ui.RunSpinner("Fetching add-ons...", func() {
				view, err = client.GetProjectAddons(project, env)
			})
			if err != nil {
				failf("Failed to list add-ons: %v", err)
			}
			if view == nil || len(view.Addons) == 0 {
				ui.Muted("No add-ons installed.")
				return
			}
			_ = ui.ShowTable(addonColumns, addonRows(view.Addons), "add-ons")
			return
		}
		if err := runAddonList(client, os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to list add-ons: %v", err)
		}
	},
}

var addonColumns = []string{"Add-on", "Enabled", "Mode", "Version", "Status", "Health"}

// addonRows projects installed add-ons into plain table cells.
func addonRows(addons []api.Addon) [][]string {
	rows := make([][]string, len(addons))
	for i, a := range addons {
		rows[i] = []string{
			a.AddonID,
			gateGlyph(a.Enabled),
			a.Mode,
			strOrDash(a.Version),
			a.Status,
			strOrDash(a.Health),
		}
	}
	return rows
}

// strOrDash renders a nullable string, or the dash glyph when nil/empty.
func strOrDash(s *string) string {
	if s == nil || *s == "" {
		return ui.SymbolDash
	}
	return *s
}

// runAddonList fetches and renders a project environment's installed add-ons. json emits the
// whole view; table/csv emit the add-on rows.
func runAddonList(c apiClient, out io.Writer, format, project, env string) error {
	view, err := c.GetProjectAddons(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, view)
	}
	if (view == nil || len(view.Addons) == 0) && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No add-ons installed."))
		return nil
	}
	var addons []api.Addon
	if view != nil {
		addons = view.Addons
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: addonColumns,
		Rows:    addonRows(addons),
	}, addons)
}

func init() {
	addonCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	addonCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	addonCmd.AddCommand(addonListCmd)
	rootCmd.AddCommand(addonCmd)
}
