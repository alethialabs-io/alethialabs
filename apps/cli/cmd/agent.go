// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var agentCmd = &cobra.Command{
	Use:     "agent",
	Aliases: []string{"agents"},
	Short:   "Inspect agent identities",
	Long: `Agent identities are machine/agent personas — a persona, a mission, an allowed tool
scope, and a memory namespace — scoped to your account or organization. List them or show one.`,
}

var agentListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the agent identities you can see",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var agents []api.Agent
			ui.RunSpinner("Fetching agents...", func() {
				agents, err = client.ListAgents()
			})
			if err != nil {
				failf("Failed to list agents: %v", err)
			}
			if len(agents) == 0 {
				ui.Muted("No agent identities.")
				return
			}
			_ = ui.ShowTable(agentColumns, agentRows(agents), "agents")
			return
		}
		if err := runAgentList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list agents: %v", err)
		}
	},
}

var agentColumns = []string{"ID", "Persona", "Tools", "Namespace", "Version"}

// agentRows projects agent identities into plain table cells.
func agentRows(agents []api.Agent) [][]string {
	rows := make([][]string, len(agents))
	for i, a := range agents {
		tools := fmt.Sprintf("%d", len(a.ToolScope))
		rows[i] = []string{a.ID, a.Persona, tools, a.MemoryNamespace, fmt.Sprintf("%d", a.Version)}
	}
	return rows
}

// runAgentList fetches and renders the caller's agent identities (non-interactive path).
func runAgentList(c apiClient, out io.Writer, format string) error {
	agents, err := c.ListAgents()
	if err != nil {
		return err
	}
	if len(agents) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No agent identities."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{Columns: agentColumns, Rows: agentRows(agents)}, agents)
}

var agentGetCmd = &cobra.Command{
	Use:   "get <agent-id>",
	Short: "Show an agent identity's persona, mission, and tool scope",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runAgentGet(api.NewClient(token), os.Stdout, outputFormat(cmd), args[0]); err != nil {
			failf("Failed to get agent: %v", err)
		}
	},
}

// runAgentGet fetches and renders one agent identity. json emits the whole object; table/csv render
// the field/value card.
func runAgentGet(c apiClient, out io.Writer, format, id string) error {
	a, err := c.GetAgent(id)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, a)
	}
	tools := ui.SymbolDash
	if len(a.ToolScope) > 0 {
		tools = strings.Join(a.ToolScope, ", ")
	}
	rows := [][]string{
		{"id", a.ID},
		{"persona", a.Persona},
		{"mission", a.Mission},
		{"tool scope", tools},
		{"namespace", a.MemoryNamespace},
		{"version", fmt.Sprintf("%d", a.Version)},
	}
	return ui.RenderCard(out, format, "alethia · agent", rows, a)
}

func init() {
	agentCmd.AddCommand(agentListCmd)
	agentCmd.AddCommand(agentGetCmd)
	rootCmd.AddCommand(agentCmd)
}
