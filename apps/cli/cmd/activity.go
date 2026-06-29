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

var activityLimit int

var activityCmd = &cobra.Command{
	Use:   "activity",
	Short: "Show the organization's delivery/activity log",
	Long: `Read the active organization's activity log — every recorded action and
denial, newest first — including alert deliveries. Use -n/--limit to cap the
number of rows.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var entries []api.ActivityEntry
			ui.RunSpinner("Fetching activity...", func() { entries, err = client.ListActivity(activityLimit) })
			if err != nil {
				failf("Failed to read activity: %v", err)
			}
			if len(entries) == 0 {
				ui.Muted("No activity found.")
				return
			}
			_ = ui.ShowTable(activityColumns, activityRows(entries), "activity")
			return
		}
		if err := runActivity(client, os.Stdout, outputFormat(cmd), activityLimit); err != nil {
			failf("Failed to read activity: %v", err)
		}
	},
}

var activityColumns = []string{"Time", "Actor", "Action", "Resource", "Decision"}

// activityRows projects activity entries into plain table rows. The actor prefers
// the email (falling back to the actor id); the decision renders allow/deny.
func activityRows(entries []api.ActivityEntry) [][]string {
	rows := make([][]string, len(entries))
	for i, e := range entries {
		actor := e.ActorEmail
		if actor == "" {
			actor = e.ActorID
		}
		rows[i] = []string{formatCreatedAt(e.Ts), actor, e.Action, e.ResourceType, decisionLabel(e.Decision)}
	}
	return rows
}

// decisionLabel maps the PDP decision boolean to a human label.
func decisionLabel(allowed bool) string {
	if allowed {
		return "allow"
	}
	return "deny"
}

// runActivity fetches and renders the activity log (non-interactive path).
func runActivity(c apiClient, out io.Writer, format string, limit int) error {
	entries, err := c.ListActivity(limit)
	if err != nil {
		return err
	}
	if len(entries) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No activity found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: activityColumns,
		Rows:    activityRows(entries),
	}, entries)
}

func init() {
	activityCmd.Flags().IntVarP(&activityLimit, "limit", "n", 50, "Maximum number of entries to show")
	rootCmd.AddCommand(activityCmd)
}
