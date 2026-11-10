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
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var view *api.ProjectAddons
			runSpinner("Fetching add-ons...", func() {
				view, err = client.GetProjectAddons(project, env)
			})
			if err != nil {
				failf("Failed to list add-ons: %v", err)
			}
			if view == nil || len(view.Addons) == 0 {
				ui.Muted("No add-ons installed.")
				return
			}
			_ = ui.ShowTable(addonColumns, addonRows(view.Addons, ui.FormatTable), "add-ons")
			for _, n := range addonSecurityNotices(view.Addons, project, env) {
				ui.Warning(n)
			}
			return
		}
		if err := runAddonList(client, os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to list add-ons: %v", err)
		}
	},
}

// addonColumns are the table's columns. SYNC is here and was not, and that is the one change
// worth stating: the wire has carried `sync` and `last_synced_at` since the endpoint was written
// and the table rendered neither, so the CLI showed an ArgoCD add-on's HEALTH as the only signal.
//
// Those two say different things. Health is the workload's own report — a chart with no readiness
// probe is "Healthy" the moment its pods schedule. Sync is whether ArgoCD has applied the manifest
// the control plane asked for at all, and an add-on stuck OutOfSync is the failure an operator is
// actually looking for: it renders, it says Healthy, and the change never reached the cluster.
//
// UPDATE is the catalogue's offer (#6537). A catalogue bump moves only a managed, unpinned install,
// on its next deploy; a pinned install keeps its pin and a GitOps install keeps what its repo says.
// Without this column neither ever heard that the catalogue had moved on.
var addonColumns = []string{"Add-on", "Enabled", "Mode", "Version", "Update", "Status", "Sync", "Health", "Last synced"}

// addonUpdateCell renders the catalogue's offer for one add-on: the dash when it follows the
// catalogue, else the catalogue's version — marked SECURITY when it is a security release, and
// "repo decides" for a GitOps install, whose version only its apps repo knows.
func addonUpdateCell(u *api.AddonUpdate) string {
	if u == nil {
		return ""
	}
	cell := u.CatalogVersion + " available"
	if u.Kind == "gitops" {
		cell = "repo decides (catalog " + u.CatalogVersion + ")"
	}
	if u.Security {
		cell = "SECURITY " + cell
	}
	return cell
}

// addonSecurityNotices are the lines printed under the table for each security update: what to
// run (a pin) or what to edit (a GitOps manifest). The CLI never applies one itself — the pin and
// the repo are the user's — so the line hands them the exact command or file.
func addonSecurityNotices(addons []api.Addon, project, env string) []string {
	var out []string
	for _, a := range addons {
		u := a.Update
		if u == nil || !u.Security {
			continue
		}
		summary := ""
		if u.SecuritySummary != nil {
			summary = " " + *u.SecuritySummary
		}
		if u.Kind == "gitops" {
			out = append(out, fmt.Sprintf("%s: the catalog's %s is a security release.%s Your apps repo decides this add-on's version: "+
				"set spec.source.targetRevision in addons/%s.yaml to %s if it is older.", a.AddonID, u.CatalogVersion, summary, a.AddonID, u.CatalogVersion))
			continue
		}
		cmd := fmt.Sprintf("alethia addon enable %s --version %s --project %s", a.AddonID, u.CatalogVersion, project)
		if env != "" {
			cmd += " --env " + env
		}
		out = append(out, fmt.Sprintf("%s: pinned to %s; the catalog's %s is a security release.%s Update the pin with: %s",
			a.AddonID, ui.StrOrDash(a.Version), u.CatalogVersion, summary, cmd))
	}
	return out
}

// addonRows projects installed add-ons into plain table cells.
func addonRows(addons []api.Addon, outFmt string) [][]string {
	rows := make([][]string, len(addons))
	for i, a := range addons {
		rows[i] = []string{
			a.AddonID,
			ui.Cell(outFmt, ui.WireBool(a.Enabled), ui.GateGlyph(a.Enabled)),
			ui.Cell(outFmt, a.Mode, ui.OrDash(a.Mode)),
			ui.Cell(outFmt, ui.Wire(a.Version), ui.StrOrDash(a.Version)),
			ui.Cell(outFmt, addonUpdateCell(a.Update), ui.OrDash(addonUpdateCell(a.Update))),
			ui.Cell(outFmt, a.Status, ui.OrDash(a.Status)),
			ui.Cell(outFmt, ui.Wire(a.Sync), ui.StrOrDash(a.Sync)),
			ui.Cell(outFmt, ui.Wire(a.Health), ui.StrOrDash(a.Health)),
			// "never" and not a dash: an add-on that has never synced is a DIFFERENT statement
			// from one whose last sync we failed to read, and it is the one that explains an
			// Application sitting Progressing since it was enabled.
			ui.Cell(outFmt, ui.Wire(a.LastSyncedAt), ui.StampOrNever(a.LastSyncedAt)),
		}
	}
	return rows
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
	if err := ui.Render(out, format, ui.TableSpec{
		Columns: addonColumns,
		Rows:    addonRows(addons, format),
	}, addons); err != nil {
		return err
	}
	// Under the table only: CSV is read by programs, and a prose line would be a malformed row.
	if format == ui.FormatTable {
		for _, n := range addonSecurityNotices(addons, project, env) {
			fmt.Fprintln(out, ui.WarningStyle.Render(ui.SymbolPoint+" "+n))
		}
	}
	return nil
}

func init() {
	addonCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	addonCmd.PersistentFlags().StringP("env", "e", "", "Environment id, name or stage — an exact name wins over a stage (default: the project's default environment)")
	addonCmd.AddCommand(addonListCmd)
	rootCmd.AddCommand(addonCmd)
}
