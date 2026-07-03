// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

var envListColumns = []string{"Name", "Stage", "Status", "Default", "Region"}

// envRows projects environments into plain table rows.
func envRows(envs []api.Environment) [][]string {
	rows := make([][]string, len(envs))
	for i, e := range envs {
		region := ui.SymbolDash
		if e.Region != nil && *e.Region != "" {
			region = *e.Region
		}
		rows[i] = []string{e.Name, e.Stage, e.Status, yesNo(e.IsDefault), region}
	}
	return rows
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
	projectEnvStage  string
	projectEnvRegion string
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
		if err := runProjectEnvAdd(api.NewClient(token), os.Stdout, project, args[0], projectEnvStage, projectEnvRegion); err != nil {
			failf("Failed to add environment: %v", err)
		}
	},
}

// runProjectEnvAdd adds an environment and confirms it.
func runProjectEnvAdd(c apiClient, out io.Writer, project, name, stage, region string) error {
	env, err := c.AddEnvironment(project, name, stage, region)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Added environment %s (%s)", env.Name, env.Stage)))
	return nil
}

func init() {
	projectEnvCmd.PersistentFlags().String("project", "", "Project name or id")
	projectEnvAddCmd.Flags().StringVar(&projectEnvStage, "stage", "development", "Environment stage (development|staging|production)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvRegion, "region", "", "Region (inherits the project's region when omitted)")
	projectEnvCmd.AddCommand(projectEnvListCmd)
	projectEnvCmd.AddCommand(projectEnvAddCmd)
	projectCmd.AddCommand(projectEnvCmd)
}
