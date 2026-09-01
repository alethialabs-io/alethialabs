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

var projectEnvCmd = &cobra.Command{
	Use:   "env",
	Short: "Manage a project's environments",
	Long: `A project owns N independently-provisionable environments (development, staging,
production, …). List a project's environments or add a new one. The project is named with
--project (its name or id).`,
}

// currentProject resolves the project the env/component commands operate on from the
// --project flag (its name or id). There is no implicit "active project", so it is required.
func currentProject(cmd *cobra.Command) (string, error) {
	if p, _ := cmd.Flags().GetString("project"); p != "" {
		return p, nil
	}
	return "", fmt.Errorf("--project is required (pass the project name or id)")
}

var projectEnvListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's environments",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var envs []api.Environment
			ui.RunSpinner("Fetching environments...", func() { envs, err = client.ListEnvironments(project) })
			if err != nil {
				failf("Failed to list environments: %v", err)
			}
			if len(envs) == 0 {
				ui.Muted("No environments found.")
				return
			}
			_ = ui.ShowTable(envListColumns, envRows(envs), "environments")
			return
		}
		if err := runProjectEnvList(client, os.Stdout, outputFormat(cmd), project); err != nil {
			failf("Failed to list environments: %v", err)
		}
	},
}

// Placement, Namespace and Fabric sit next to each other deliberately: read across a row and
// you get the whole claim — this tier is a namespace, in boutique-dev-1, on the Fabric named
// prod, which the row above owns. Without them the list answered Name/Stage/Status/Default/
// Region, none of which distinguishes an environment that bought a cluster from one that
// cost nothing, which is the single thing the isolation ladder exists to show.
var envListColumns = []string{
	"Name", "Stage", "Placement", "Namespace", "Fabric", "Status", "Default", "Region",
}

// envRows projects environments into plain table rows.
func envRows(envs []api.Environment) [][]string {
	rows := make([][]string, len(envs))
	for i, e := range envs {
		rows[i] = []string{
			e.Name,
			e.Stage,
			ui.OrDash(e.PlacementMode),
			derefOrDash(e.Namespace),
			derefOrDash(e.Fabric),
			e.Status,
			ui.YesNo(e.IsDefault),
			derefOrDash(e.Region),
		}
	}
	return rows
}

// derefOrDash is orDash for an optional field: nil and "" both render as the table's dash, so a
// blank cell is never mistaken for a value the server actually returned. The pointer cases are
// real — a dedicated environment has no namespace, and a Fabric may not exist yet.
func derefOrDash(s *string) string {
	if s == nil {
		return ui.SymbolDash
	}
	return ui.OrDash(*s)
}

// runProjectEnvList fetches and renders a project's environments (non-interactive path).
func runProjectEnvList(c apiClient, out io.Writer, format, project string) error {
	envs, err := c.ListEnvironments(project)
	if err != nil {
		return err
	}
	if len(envs) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No environments found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: envListColumns,
		Rows:    envRows(envs),
	}, envs)
}

var (
	projectEnvStage     string
	projectEnvRegion    string
	projectEnvPlacement string
	projectEnvFabric    string
	projectEnvNamespace string
	projectEnvLifecycle string
)

var projectEnvAddCmd = &cobra.Command{
	Use:   "add <name>",
	Short: "Add an environment to a project",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		if err := runProjectEnvAdd(api.NewClient(token), os.Stdout, api.AddEnvironmentParams{
			Project:   project,
			Name:      args[0],
			Stage:     projectEnvStage,
			Region:    projectEnvRegion,
			Placement: projectEnvPlacement,
			Fabric:    projectEnvFabric,
			Namespace: projectEnvNamespace,
			Lifecycle: projectEnvLifecycle,
		}); err != nil {
			failf("Failed to add environment: %v", err)
		}
	},
}

// runProjectEnvAdd adds an environment and confirms it. The confirmation names the PLACEMENT, because
// that is the field with a cost: a `dedicated` environment is a whole new cluster with its own state
// key, and until this flag existed every CLI-added environment silently became one.
func runProjectEnvAdd(c apiClient, out io.Writer, params api.AddEnvironmentParams) error {
	env, err := c.AddEnvironment(params)
	if err != nil {
		return err
	}
	placement := params.Placement
	if placement == "" {
		placement = "namespace"
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Added environment %s (%s, %s placement)", env.Name, env.Stage, placement)))
	return nil
}

func init() {
	projectEnvCmd.PersistentFlags().String("project", "", "Project name or id")
	projectEnvAddCmd.Flags().StringVar(&projectEnvStage, "stage", "development", "Environment stage (development|staging|production)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvRegion, "region", "", "Region (inherits the project's region when omitted)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvPlacement, "placement-mode", "", "Placement onto a Fabric: namespace|vcluster|dedicated (default namespace — `dedicated` provisions a NEW cluster)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvFabric, "fabric", "", "Fabric to place onto, by name (default: the Fabric the project's default environment is on)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvNamespace, "namespace", "", "ArgoCD destination namespace for a shared placement (default: derived from the name)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvLifecycle, "lifecycle", "", "persistent|ephemeral (default persistent)")
	projectEnvCmd.AddCommand(projectEnvListCmd)
	projectEnvCmd.AddCommand(projectEnvAddCmd)
	projectCmd.AddCommand(projectEnvCmd)
}
