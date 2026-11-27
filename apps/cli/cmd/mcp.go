// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/mcp"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// `alethia mcp` (agent surface §4.7, L11): this CLI as a local MCP server over stdio, for the
// clients that cannot reach the remote server at <origin>/api/mcp. The server and its tool list live
// in internal/mcp; this file is the command, its flags, and its registry entry.

var (
	mcpToolSet     string
	mcpCallTimeout time.Duration
)

// mcpDefaultCallTimeout bounds one tool call. A command that waits on a job past it is stopped and
// the agent is told to read the job instead.
const mcpDefaultCallTimeout = 10 * time.Minute

var mcpCmd = &cobra.Command{
	Use: "mcp",
	// The upgrade notice is a sentence for a person; a client reading the protocol stream has no use for it.
	Annotations: map[string]string{skipUpdateNoticeAnnotation: "true"},
	Short:       "Serve this CLI's commands to a coding agent as a local MCP server over stdio",
	Args:        cobra.NoArgs,
	Long: `Run this CLI as an MCP server on standard input and output, for a coding agent that
starts local servers rather than connecting to the remote one (alethia agent setup configures the
remote one).

Each tool is one alethia command. A call runs that command in agent mode, as the person signed in
to this CLI, so a tool can do exactly what the command can and the control plane asks for the same
approvals: a deploy or a destroy waits for a person to approve the plan in the console. No tool
approves, signs in, changes this CLI's settings, or prints a credential.

--tools chooses how much is offered:

  read-only     commands that change nothing
  standard      also the deploy and inspect commands that change something without removing it
  destructive   also the deploy and inspect commands that remove records or tear infrastructure down

Commands that decide who may do what (members, grants, roles, tokens), which cloud accounts are
trusted (connector) and how far runners scale (fleet) are offered read-only at every level.

An MCP client starts the server itself. Run on a terminal, it asks which tools to offer and prints
the configuration to add to your client instead of serving.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runMCP(cmd); err != nil {
			fail(err)
		}
	},
}

// metaMCP is the command's registry entry. It is in the settings group, with the CLI's own
// configuration, which is also what keeps it out of its own tool list (internal/mcp).
var metaMCP = []cmdmeta.Meta{
	{
		Path: "alethia mcp", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia mcp", Note: "On a terminal: choose the tools and print the client configuration"},
			{Cmd: "alethia mcp --tools read-only", Note: "Serve only the commands that change nothing (what a client runs)"},
			{Cmd: "alethia mcp --tools destructive --call-timeout 30m", Note: "Also offer removals and teardowns, with a longer bound per call"},
		},
	},
}

// runMCP serves, or on a terminal asks which tools to offer and prints the client configuration.
func runMCP(cmd *cobra.Command) error {
	set, err := mcpResolveToolSet(cmd)
	if err != nil {
		return err
	}
	if canPromptForm() {
		if !cmd.Flags().Changed("tools") {
			if set, err = promptMCPToolSet(set); err != nil {
				return err
			}
		}
		return printMCPConfig(cmd, set)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Standard output is the protocol stream and nothing else may be written to it; what this
	// process has to say goes to standard error.
	return serveMCP(ctx, set, os.Stdin, os.Stdout)
}

// mcpResolveToolSet reads --tools.
func mcpResolveToolSet(cmd *cobra.Command) (mcp.ToolSet, error) {
	set, ok := mcp.ParseToolSet(strings.TrimSpace(strings.ToLower(mcpToolSet)))
	if !ok {
		return "", refusal(clierr.CodeInvalidFlag, "alethia mcp --tools read-only",
			"unknown --tools %q (want %s)", mcpToolSet, mcpToolSetNames())
	}
	if mcpCallTimeout < 0 {
		return "", refusal(clierr.CodeInvalidFlag, "", "--call-timeout must not be negative")
	}
	return set, nil
}

// mcpToolSetNames is every --tools value, comma-separated.
func mcpToolSetNames() string {
	names := make([]string, len(mcp.ToolSets))
	for i, t := range mcp.ToolSets {
		names[i] = string(t)
	}
	return strings.Join(names, ", ")
}

// promptMCPToolSet asks a person which tools the server should offer.
func promptMCPToolSet(current mcp.ToolSet) (mcp.ToolSet, error) {
	labels := map[mcp.ToolSet]string{
		mcp.ToolSetReadOnly:    "Read-only: commands that change nothing",
		mcp.ToolSetStandard:    "Standard: also create, plan, deploy, scan and attach",
		mcp.ToolSetDestructive: "Destructive: also removals and teardowns",
	}
	options := make([]huh.Option[string], len(mcp.ToolSets))
	for i, t := range mcp.ToolSets {
		options[i] = huh.NewOption(labels[t], string(t))
	}
	chosen := string(current)
	err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Which commands should the agent be able to run?").
			Description("Deploys and destroys still wait for a person's approval in the console").
			Options(options...).
			Value(&chosen),
	))
	set, _ := mcp.ParseToolSet(chosen)
	return set, err
}

// mcpConfig is what `alethia mcp` prints on a terminal: the server entry to add to a client.
type mcpConfig struct {
	ToolSet string   `json:"tool_set"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	// Tools are the names of the tools the server would offer.
	Tools []string `json:"tools"`
}

// mcpServerArgs is the command line a client starts the server with.
func mcpServerArgs(set mcp.ToolSet) []string {
	args := []string{"mcp", "--tools", string(set)}
	if mcpCallTimeout != mcpDefaultCallTimeout {
		args = append(args, "--call-timeout", mcpCallTimeout.String())
	}
	return args
}

// printMCPConfig reports the client configuration for set.
func printMCPConfig(cmd *cobra.Command, set mcp.ToolSet) error {
	tools := mcp.Select(describeCommands(), set)
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = t.Name
	}
	cfg := mcpConfig{ToolSet: string(set), Command: rootCmd.Name(), Args: mcpServerArgs(set), Tools: names}
	return printerFor(cmd).Result(cfg, func(w io.Writer) { renderMCPConfig(w, cfg) })
}

// renderMCPConfig writes the configuration for a person.
func renderMCPConfig(w io.Writer, cfg mcpConfig) {
	entry := map[string]any{"mcpServers": map[string]any{
		agentSetupServerName: map[string]any{"command": cfg.Command, "args": cfg.Args},
	}}
	b, _ := json.MarshalIndent(entry, "  ", "  ")
	fmt.Fprintf(w, "%s %d tools (%s). Add this server to your MCP client:\n\n  %s\n\n",
		ui.SymbolSuccess, len(cfg.Tools), cfg.ToolSet, b)
	fmt.Fprintln(w, ui.MutedStyle.Render("The client starts the server itself; it runs as the person signed in to this CLI."))
}

// mcpExecutable finds this program, whose commands the tools run. A variable so a test can make it
// fail.
var mcpExecutable = os.Executable

// serveMCP serves the tools of set on in and out until the client closes the connection or ctx is
// done.
func serveMCP(ctx context.Context, set mcp.ToolSet, in io.Reader, out io.Writer) error {
	exe, err := mcpExecutable()
	if err != nil {
		return clierr.New(clierr.CodeInternal, "cannot find this program to run its commands: "+err.Error())
	}
	server := mcp.NewServer(mcp.Options{
		Name:        rootCmd.Name(),
		Version:     version.Version,
		Tools:       mcp.Select(describeCommands(), set),
		Runner:      mcp.ExecRunner{Path: exe},
		CallTimeout: mcpCallTimeout,
	})
	return server.Serve(ctx, in, out)
}

// markMCPToolRequests marks every request this process sends as made for an `alethia mcp` tool call
// when the server started it for one (mcp.ToolEnv, set by the server on each child it runs). The
// console then holds those requests to the org's agent policy and records them with the other agent
// tool calls. The mark only narrows what the credential may do there; a process without it sends
// exactly what it always did.
func markMCPToolRequests(lookup func(string) string) {
	if tool := strings.TrimSpace(lookup(mcp.ToolEnv)); tool != "" {
		api.SetAgentTool(tool)
	}
}

func init() {
	markMCPToolRequests(os.Getenv)
	mcpCmd.Flags().StringVar(&mcpToolSet, "tools", string(mcp.ToolSetStandard),
		"Which commands to offer: read-only, standard or destructive (asked on a terminal)")
	mcpCmd.Flags().DurationVar(&mcpCallTimeout, "call-timeout", mcpDefaultCallTimeout,
		"Stop a tool call that runs longer than this (0: no bound)")
	_ = mcpCmd.RegisterFlagCompletionFunc("tools", func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
		return strings.Split(mcpToolSetNames(), ", "), cobra.ShellCompDirectiveNoFileComp
	})
	rootCmd.AddCommand(mcpCmd)
}
