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

var costCmd = &cobra.Command{
	Use:   "cost",
	Short: "Inspect a project environment's infrastructure cost",
	Long: `Every PLAN runs Infracost over the terraform plan and records the priced breakdown
per environment. Show the latest cost for a project environment (defaults to the project's
default environment; pass --env for another).`,
}

var costShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the latest cost for a project environment",
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
		if err := runCostShow(api.NewClient(token), os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to get cost: %v", err)
		}
	},
}

var costColumns = []string{"Address", "Type", "Monthly"}

// costRows projects priced resource lines into plain table cells.
func costRows(resources []api.CostResourceLine) [][]string {
	rows := make([][]string, len(resources))
	for i, r := range resources {
		rows[i] = []string{r.Address, r.ResourceType, fmt.Sprintf("$%.2f", r.MonthlyCost)}
	}
	return rows
}

// costSummary renders the one-line cost headline (priced / total monthly).
func costSummary(c *api.EnvironmentCost) string {
	scope := ""
	if c.Environment != nil && *c.Environment != "" {
		scope = fmt.Sprintf(" [%s]", *c.Environment)
	}
	if !c.Priced || c.TotalMonthly == nil {
		return ui.MutedStyle.Render(fmt.Sprintf("Cost%s: not priced — no plan has costed this environment yet.", scope))
	}
	when := ""
	if c.CapturedAt != nil {
		when = fmt.Sprintf(" (captured %s)", *c.CapturedAt)
	}
	return fmt.Sprintf("Cost%s: $%.2f/mo %s%s", scope, *c.TotalMonthly, c.Currency, when)
}

// runCostShow fetches and renders an environment's cost. json emits the whole cost object;
// table prints a summary headline then the priced-resource table; csv emits the resource rows.
func runCostShow(c apiClient, out io.Writer, format, project, env string) error {
	cost, err := c.GetEnvironmentCost(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, cost)
	}
	if format == ui.FormatTable {
		fmt.Fprintln(out, costSummary(cost))
		if len(cost.Resources) == 0 {
			return nil
		}
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: costColumns,
		Rows:    costRows(cost.Resources),
	}, cost.Resources)
}

func init() {
	costCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	costCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	costCmd.AddCommand(costShowCmd)
	rootCmd.AddCommand(costCmd)
}
