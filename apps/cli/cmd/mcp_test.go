// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/mcp"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// mcpToolNamePattern is what the MCP specification says a tool name SHOULD be.
var mcpToolNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

// TestMCP_TheToolListIsTheRealRegistrysCommands holds the generated tool list to its rules against
// THIS CLI's registry, not a fixture: a command added tomorrow is checked by being added.
func TestMCP_TheToolListIsTheRealRegistrysCommands(t *testing.T) {
	doc := describeCommands()
	commands := map[string]cmdmeta.CommandDoc{}
	for _, c := range doc.Commands {
		commands[strings.Join(strings.Fields(c.Path)[1:], "_")] = c
	}

	tools := mcp.Select(doc, mcp.ToolSetDestructive)
	if len(tools) < 20 {
		t.Fatalf("only %d tools at the widest tool set — the registry or the selection stopped matching", len(tools))
	}
	seen := map[string]bool{}
	for _, tool := range tools {
		c, ok := commands[tool.Name]
		switch {
		case !ok:
			t.Errorf("%s is not a command in the registry", tool.Name)
		case seen[tool.Name]:
			t.Errorf("%s is offered twice", tool.Name)
		case !mcpToolNamePattern.MatchString(tool.Name):
			t.Errorf("%s is not a valid MCP tool name", tool.Name)
		case strings.HasSuffix(c.Path, " approve"):
			t.Errorf("%s approves", tool.Name)
		case c.Output == cmdmeta.OutputSecret:
			t.Errorf("%s prints a credential", tool.Name)
		case c.Group != groupDeploy && c.Group != groupInspect && c.Group != groupOrganization:
			t.Errorf("%s is in help group %q, which is the CLI itself", tool.Name, c.Group)
		case c.Group == groupOrganization && c.Mutates:
			t.Errorf("%s changes who may do what", tool.Name)
		}
		seen[tool.Name] = true
		for _, hidden := range []string{"token", "web-origin", "output", "agent", "out"} {
			if _, ok := tool.Flags[hidden]; ok {
				t.Errorf("%s offers --%s", tool.Name, hidden)
			}
		}
	}
	for _, mustNot := range []string{"approve", "mcp", "login", "logout", "config_set", "token_create", "cluster_kubeconfig", "agent_setup"} {
		if seen[mustNot] {
			t.Errorf("%s is offered", mustNot)
		}
	}
	for _, must := range []string{"project_list", "jobs_get", "project_deploy", "project_destroy", "plan"} {
		if !seen[must] {
			t.Errorf("%s is not offered at the widest tool set", must)
		}
	}
}

// TestMCP_ToolSetsNest checks that each tool set offers everything the narrower one does, and that
// read-only offers nothing that changes anything.
func TestMCP_ToolSetsNest(t *testing.T) {
	doc := describeCommands()
	var previous []string
	for _, set := range mcp.ToolSets {
		var names []string
		for _, tool := range mcp.Select(doc, set) {
			names = append(names, tool.Name)
			if set == mcp.ToolSetReadOnly && !tool.Annotations.ReadOnlyHint {
				t.Errorf("read-only offers %s, which changes something", tool.Name)
			}
			if set == mcp.ToolSetStandard && tool.Annotations.DestructiveHint {
				t.Errorf("standard offers %s, which is destructive", tool.Name)
			}
		}
		for _, name := range previous {
			if !slices.Contains(names, name) {
				t.Errorf("%s drops %s, which a narrower set offers", set, name)
			}
		}
		if len(names) <= len(previous) {
			t.Errorf("%s offers no more than the set before it", set)
		}
		previous = names
	}
}

func TestMCP_RefusesAnUnknownToolSet(t *testing.T) {
	old := mcpToolSet
	t.Cleanup(func() { mcpToolSet = old })
	mcpToolSet = "everything"
	if _, err := mcpResolveToolSet(mcpCmd); err == nil {
		t.Fatal("--tools everything was accepted")
	}
	mcpToolSet = "Read-Only"
	if set, err := mcpResolveToolSet(mcpCmd); err != nil || set != mcp.ToolSetReadOnly {
		t.Errorf("--tools Read-Only = %q, %v", set, err)
	}
}

func TestMCP_ServerArgsNameTheToolSet(t *testing.T) {
	old := mcpCallTimeout
	t.Cleanup(func() { mcpCallTimeout = old })
	mcpCallTimeout = mcpDefaultCallTimeout
	if got := strings.Join(mcpServerArgs(mcp.ToolSetReadOnly), " "); got != "mcp --tools read-only" {
		t.Errorf("args = %q", got)
	}
	mcpCallTimeout = 2 * mcpDefaultCallTimeout
	if got := strings.Join(mcpServerArgs(mcp.ToolSetStandard), " "); got != "mcp --tools standard --call-timeout 20m0s" {
		t.Errorf("args = %q", got)
	}
}

// mcpCapture points the process printer at buffers for one test and returns them.
func mcpCapture(t *testing.T) (*bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	prev := printer
	var out, errOut bytes.Buffer
	printer = &Printer{Out: &out, Err: &errOut, Format: ui.FormatTable, Mode: Mode{}}
	t.Cleanup(func() { printer = prev })
	return &out, &errOut
}

// TestMCP_OnATerminalItAsksAndPrintsTheConfiguration drives the real select: one cursor-down from the seed
// (standard) lands on destructive, which only the widget could have produced.
func TestMCP_OnATerminalItAsksAndPrintsTheConfiguration(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	out, _ := mcpCapture(t)
	scripts := authFormAnswer(t, tailFormsDown(1))
	if err := runMCP(mcpCmd); err != nil {
		t.Fatal(err)
	}
	if !scripts[0].ran {
		t.Fatal("no form was opened")
	}
	got := out.String()
	if !strings.Contains(got, `"destructive"`) || !strings.Contains(got, `"mcpServers"`) || !strings.Contains(got, `"--tools"`) {
		t.Errorf("printed:\n%s", got)
	}
}

// TestMCP_OnATerminalAnExplicitToolSetIsNotAskedFor pins that --tools answers the question.
func TestMCP_OnATerminalAnExplicitToolSetIsNotAskedFor(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsTTY(t)
	authFormNoForm(t)
	out, _ := mcpCapture(t)
	if err := mcpCmd.Flags().Set("tools", "read-only"); err != nil {
		t.Fatal(err)
	}
	if err := runMCP(mcpCmd); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "(read-only)") {
		t.Errorf("printed:\n%s", out.String())
	}
}

// TestMCP_ServesTheGeneratedListOverTheStreams runs the server the command builds, end to end over
// a pipe, and checks it lists exactly the generated tools.
func TestMCP_ServesTheGeneratedListOverTheStreams(t *testing.T) {
	resetFlagsAroundTest(t)
	in := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n")
	var out bytes.Buffer
	if err := serveMCP(context.Background(), mcp.ToolSetReadOnly, in, &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("responses:\n%s", out.String())
	}
	var list struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &list); err != nil {
		t.Fatal(err)
	}
	if want := len(mcp.Select(describeCommands(), mcp.ToolSetReadOnly)); len(list.Result.Tools) != want || want == 0 {
		t.Errorf("listed %d tools, want %d", len(list.Result.Tools), want)
	}
}

func TestMCP_RefusesToServeWithoutItsOwnExecutable(t *testing.T) {
	prev := mcpExecutable
	t.Cleanup(func() { mcpExecutable = prev })
	mcpExecutable = func() (string, error) { return "", errors.New("gone") }
	if err := serveMCP(context.Background(), mcp.ToolSetReadOnly, strings.NewReader(""), io.Discard); err == nil {
		t.Fatal("served without an executable to run")
	}
}

func TestMCP_RefusesANegativeCallTimeout(t *testing.T) {
	resetFlagsAroundTest(t)
	mcpCallTimeout = -time.Second
	if _, err := mcpResolveToolSet(mcpCmd); err == nil {
		t.Fatal("a negative --call-timeout was accepted")
	}
}

func TestMCP_HeadlessRunServesStandardStreams(t *testing.T) {
	resetFlagsAroundTest(t)
	tailFormsHeadless(t)
	prevIn := os.Stdin
	t.Cleanup(func() { os.Stdin = prevIn })
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	os.Stdin = r
	if err := runMCP(mcpCmd); err != nil {
		t.Fatalf("a closed stdin should end the session cleanly: %v", err)
	}
}

// agentHeadersSent returns the agent headers the control plane sees on one request this process
// sends after markMCPToolRequests read env.
func agentHeadersSent(t *testing.T, env map[string]string) (string, string) {
	t.Helper()
	isolatedHome(t)
	var agent, tool string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agent, tool = r.Header.Get(api.AgentHeader), r.Header.Get(api.AgentToolHeader)
		_, _ = io.WriteString(w, `{"runners":[]}`)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Cleanup(func() { api.SetAgentTool("") })
	markMCPToolRequests(func(k string) string { return env[k] })
	if _, err := api.NewClient("tok").GetRunners(); err != nil {
		t.Fatalf("GetRunners: %v", err)
	}
	return agent, tool
}

// TestMCP_AChildStartedForAToolMarksItsRequests: the child `alethia mcp` runs for a tool call sends
// the agent headers, naming the tool, so the console can hold it to the org's agent policy.
func TestMCP_AChildStartedForAToolMarksItsRequests(t *testing.T) {
	agent, tool := agentHeadersSent(t, map[string]string{mcp.ToolEnv: "project_list"})
	if agent != api.AgentClientMCP || tool != "project_list" {
		t.Errorf("headers = %q, %q; want %q, project_list", agent, tool, api.AgentClientMCP)
	}
}

// TestMCP_AnOrdinaryRunSendsNoAgentHeaders: without the server's mark a command's requests are
// unchanged, including one run in agent mode by hand.
func TestMCP_AnOrdinaryRunSendsNoAgentHeaders(t *testing.T) {
	agent, tool := agentHeadersSent(t, map[string]string{"ALETHIA_AGENT": "yes", mcp.ToolEnv: "  "})
	if agent != "" || tool != "" {
		t.Errorf("headers = %q, %q; want neither", agent, tool)
	}
}
