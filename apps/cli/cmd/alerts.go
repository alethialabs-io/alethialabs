// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var alertsCmd = &cobra.Command{
	Use:     "alerts",
	Aliases: []string{"alert"},
	Short:   "Manage alert rules",
	Long: `Alert rules bind product events (event-key patterns like system.job.failed or
authz.*.denied) to notification channels. List, create, and delete the active
organization's rules. See delivery history with "alethia activity".`,
}

var alertsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List alert rules",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var rules []api.AlertRule
			ui.RunSpinner("Fetching alert rules...", func() { rules, err = client.ListAlertRules() })
			if err != nil {
				failf("Failed to list alert rules: %v", err)
			}
			if len(rules) == 0 {
				ui.Muted("No alert rules found.")
				return
			}
			_ = ui.ShowTable(alertListColumns, alertRows(rules), "alert rules")
			return
		}
		if err := runAlertsList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list alert rules: %v", err)
		}
	},
}

var alertListColumns = []string{"Name", "Severity", "Events", "Channels", "Enabled", "ID"}

// alertRows projects alert rules into plain table rows.
func alertRows(rules []api.AlertRule) [][]string {
	rows := make([][]string, len(rules))
	for i, r := range rules {
		rows[i] = []string{
			r.Name,
			r.Severity,
			strconv.Itoa(len(r.EventPatterns)),
			strconv.Itoa(len(r.ChannelIDs)),
			yesNo(r.Enabled),
			r.ID,
		}
	}
	return rows
}

// runAlertsList fetches and renders the alert rules (non-interactive path).
func runAlertsList(c apiClient, out io.Writer, format string) error {
	rules, err := c.ListAlertRules()
	if err != nil {
		return err
	}
	if len(rules) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No alert rules found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: alertListColumns,
		Rows:    alertRows(rules),
	}, rules)
}

var (
	alertEventPatterns []string
	alertChannelIDs    []string
	alertSeverity      string
)

var alertsCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create an alert rule",
	Long: `Create an alert rule binding one or more event-key patterns to notification
channels. Repeat --event and --channel for multiple values.`,
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runAlertsCreate(api.NewClient(token), os.Stdout, args[0], alertEventPatterns, alertChannelIDs, alertSeverity); err != nil {
			failf("Failed to create alert rule: %v", err)
		}
	},
}

// runAlertsCreate creates an alert rule and confirms it.
func runAlertsCreate(c apiClient, out io.Writer, name string, eventPatterns, channelIDs []string, severity string) error {
	rule, err := c.CreateAlertRule(name, eventPatterns, channelIDs, severity)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Created alert rule %s (%s)", rule.Name, rule.ID)))
	return nil
}

var alertsDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete an alert rule",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if !confirm("Delete this alert rule?", "Matching events will no longer be routed. This cannot be undone.") {
			return
		}
		if err := runAlertsDelete(api.NewClient(token), os.Stdout, args[0]); err != nil {
			failf("Failed to delete alert rule: %v", err)
		}
	},
}

// runAlertsDelete deletes an alert rule and confirms it.
func runAlertsDelete(c apiClient, out io.Writer, id string) error {
	if err := c.DeleteAlertRule(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Alert rule deleted"))
	return nil
}

func init() {
	alertsCreateCmd.Flags().StringArrayVar(&alertEventPatterns, "event", nil, "Event-key pattern (repeatable, e.g. system.job.failed)")
	alertsCreateCmd.Flags().StringArrayVar(&alertChannelIDs, "channel", nil, "Channel id to route to (repeatable)")
	alertsCreateCmd.Flags().StringVar(&alertSeverity, "severity", "warning", "Severity (info, warning, critical)")
	_ = alertsCreateCmd.MarkFlagRequired("event")
	_ = alertsCreateCmd.MarkFlagRequired("channel")

	alertsCmd.AddCommand(alertsListCmd)
	alertsCmd.AddCommand(alertsCreateCmd)
	alertsCmd.AddCommand(alertsDeleteCmd)
	rootCmd.AddCommand(alertsCmd)
}
