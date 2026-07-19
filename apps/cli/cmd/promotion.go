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

var promotionCmd = &cobra.Command{
	Use:     "promotion",
	Aliases: []string{"promotions", "promo"},
	Short:   "Inspect environment promotions",
	Long: `A promotion moves a source environment's proven design into a target environment,
gated by that environment's protection rules. List a project's promotions or show one in detail
(status, approval tally, and approval slots).`,
}

var promotionListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's promotions",
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
			var promos []api.Promotion
			ui.RunSpinner("Fetching promotions...", func() {
				promos, err = client.GetProjectPromotions(project, env)
			})
			if err != nil {
				failf("Failed to list promotions: %v", err)
			}
			if len(promos) == 0 {
				ui.Muted("No promotions yet.")
				return
			}
			_ = ui.ShowTable(promotionColumns, promotionListRows(promos), "promotions")
			return
		}
		if err := runPromotionList(client, os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to list promotions: %v", err)
		}
	},
}

var promotionColumns = []string{"ID", "Source", "Target", "Status", "Created"}

// promotionListRows projects promotions into plain table cells.
func promotionListRows(promos []api.Promotion) [][]string {
	rows := make([][]string, len(promos))
	for i, p := range promos {
		rows[i] = []string{p.ID, p.Source, p.Target, p.Status, p.CreatedAt}
	}
	return rows
}

// runPromotionList fetches and renders a project's promotions (non-interactive path).
func runPromotionList(c apiClient, out io.Writer, format, project, env string) error {
	promos, err := c.GetProjectPromotions(project, env)
	if err != nil {
		return err
	}
	if len(promos) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No promotions yet."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: promotionColumns,
		Rows:    promotionListRows(promos),
	}, promos)
}

var promotionGetCmd = &cobra.Command{
	Use:   "get <promotion-id>",
	Short: "Show a promotion's status and approval slots",
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
		if err := runPromotionGet(api.NewClient(token), os.Stdout, outputFormat(cmd), project, args[0]); err != nil {
			failf("Failed to get promotion: %v", err)
		}
	},
}

var approvalColumns = []string{"Status", "Approver", "Role", "Decided"}

// approvalRows projects a promotion's approval slots into plain table cells.
func approvalRows(approvals []api.PromotionApproval) [][]string {
	rows := make([][]string, len(approvals))
	for i, a := range approvals {
		rows[i] = []string{a.Status, strOrDash(a.Name), strOrDash(a.RequiredRole), strOrDash(a.DecidedAt)}
	}
	return rows
}

// runPromotionGet fetches and renders one promotion. json emits the whole detail; table renders a
// summary card followed by the approval slots.
func runPromotionGet(c apiClient, out io.Writer, format, project, promotionID string) error {
	p, err := c.GetPromotion(project, promotionID)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, p)
	}
	rows := [][]string{
		{"id", p.ID},
		{"promotion", fmt.Sprintf("%s %s %s", p.Source, ui.SymbolArrow, p.Target)},
		{"status", p.Status},
		{"approvals", fmt.Sprintf("%d/%d", p.Approved, p.Required)},
		{"initiator", strOrDash(p.Initiator)},
		{"created", p.CreatedAt},
	}
	if p.ErrorMessage != nil && *p.ErrorMessage != "" {
		rows = append(rows, []string{"error", *p.ErrorMessage})
	}
	if err := ui.RenderCard(out, format, "alethia · promotion", rows, p); err != nil {
		return err
	}
	if format == ui.FormatTable && len(p.Approvals) > 0 {
		fmt.Fprintln(out)
		_ = ui.Render(out, format, ui.TableSpec{
			Columns: approvalColumns,
			Rows:    approvalRows(p.Approvals),
		}, p.Approvals)
	}
	return nil
}

func init() {
	promotionCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	promotionCmd.PersistentFlags().StringP("env", "e", "", "Filter by target environment name, stage, or id")
	promotionCmd.AddCommand(promotionListCmd)
	promotionCmd.AddCommand(promotionGetCmd)
	rootCmd.AddCommand(promotionCmd)
}
