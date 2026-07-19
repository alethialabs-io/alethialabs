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

var protectionCmd = &cobra.Command{
	Use:     "protection",
	Aliases: []string{"protect"},
	Short:   "Inspect a project's promotion protection rules",
	Long: `Protection rules gate promotion into an environment: require the predecessor stage to
be deployed and in-sync, require a passing elench verify report, require human approval, a soak
window, or a cost-delta ceiling. List the rules configured per environment.`,
}

var protectionListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's per-environment protection rules",
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
			var rules []api.ProtectionRule
			ui.RunSpinner("Fetching protection rules...", func() {
				rules, err = client.GetProjectProtection(project)
			})
			if err != nil {
				failf("Failed to list protection rules: %v", err)
			}
			if len(rules) == 0 {
				ui.Muted("No protection rules configured.")
				return
			}
			_ = ui.ShowTable(protectionColumns, protectionRows(rules), "protection rules")
			return
		}
		if err := runProtectionList(client, os.Stdout, outputFormat(cmd), project); err != nil {
			failf("Failed to list protection rules: %v", err)
		}
	},
}

var protectionColumns = []string{"Environment", "Predecessor", "Verify", "Approval", "Approvers", "Soak (min)", "Cost Δ"}

// protectionRows projects protection rules into plain table cells; a "gate" bool renders as a
// check or the dash glyph, and unset numeric limits render as the dash glyph.
func protectionRows(rules []api.ProtectionRule) [][]string {
	rows := make([][]string, len(rules))
	for i, r := range rules {
		rows[i] = []string{
			r.Environment,
			gateGlyph(r.RequirePredecessor),
			gateGlyph(r.RequireVerifyPass),
			gateGlyph(r.RequireApproval),
			intOrDash(r.MinCount),
			intOrDash(r.SoakMinutes),
			floatOrDash(r.CostDeltaThreshold),
		}
	}
	return rows
}

// gateGlyph renders a protection gate bool as a check mark or the dash glyph.
func gateGlyph(on bool) string {
	if on {
		return ui.SymbolSuccess
	}
	return ui.SymbolDash
}

// intOrDash renders a nullable int, or the dash glyph when unset.
func intOrDash(v *int) string {
	if v == nil {
		return ui.SymbolDash
	}
	return fmt.Sprintf("%d", *v)
}

// floatOrDash renders a nullable USD/mo threshold, or the dash glyph when unset.
func floatOrDash(v *float64) string {
	if v == nil {
		return ui.SymbolDash
	}
	return fmt.Sprintf("$%.2f", *v)
}

// runProtectionList fetches and renders a project's protection rules (non-interactive path).
func runProtectionList(c apiClient, out io.Writer, format, project string) error {
	rules, err := c.GetProjectProtection(project)
	if err != nil {
		return err
	}
	if len(rules) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No protection rules configured."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: protectionColumns,
		Rows:    protectionRows(rules),
	}, rules)
}

func init() {
	protectionCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	protectionCmd.AddCommand(protectionListCmd)
	rootCmd.AddCommand(protectionCmd)
}
