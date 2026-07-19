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

var stagedCmd = &cobra.Command{
	Use:   "staged",
	Short: "Inspect an environment's staged (pending) canvas changes",
	Long: `Staged changes are the durable diff between a project environment's edited canvas and
its live config — the Pending Changes an apply would push. List them for an environment (defaults
to the project's default environment; pass --env for another).`,
}

var stagedListCmd = &cobra.Command{
	Use:   "list",
	Short: "List an environment's staged changes",
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
			var view *api.StagedChanges
			ui.RunSpinner("Fetching staged changes...", func() {
				view, err = client.GetProjectStagedChanges(project, env)
			})
			if err != nil {
				failf("Failed to list staged changes: %v", err)
			}
			if view == nil || len(view.Changes) == 0 {
				ui.Muted("No staged changes.")
				return
			}
			_ = ui.ShowTable(stagedColumns, stagedRows(view.Changes), "staged changes")
			return
		}
		if err := runStagedList(client, os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to list staged changes: %v", err)
		}
	},
}

var stagedColumns = []string{"Op", "Component", "Component ID", "Created"}

// stagedRows projects staged changes into plain table cells.
func stagedRows(changes []api.StagedChange) [][]string {
	rows := make([][]string, len(changes))
	for i, c := range changes {
		rows[i] = []string{c.Op, c.ComponentType, strOrDash(c.ComponentID), c.CreatedAt}
	}
	return rows
}

// runStagedList fetches and renders an environment's staged changes. json emits the whole view;
// table/csv emit the change rows.
func runStagedList(c apiClient, out io.Writer, format, project, env string) error {
	view, err := c.GetProjectStagedChanges(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, view)
	}
	if (view == nil || len(view.Changes) == 0) && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No staged changes."))
		return nil
	}
	var changes []api.StagedChange
	if view != nil {
		changes = view.Changes
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: stagedColumns,
		Rows:    stagedRows(changes),
	}, changes)
}

func init() {
	stagedCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	stagedCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	stagedCmd.AddCommand(stagedListCmd)
	rootCmd.AddCommand(stagedCmd)
}
