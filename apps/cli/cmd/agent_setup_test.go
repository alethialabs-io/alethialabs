// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// agentSetupReset clears setup's sticky flag targets around a test.
func agentSetupReset(t *testing.T) {
	t.Helper()
	reset := func() {
		agentSetupClientIDs, agentSetupProject, agentSetupReadOnly = nil, "", false
		agentSetupDir, agentSetupNoAgentMD = "", false
	}
	reset()
	t.Cleanup(reset)
}

func TestAgentSetupMCPURL(t *testing.T) {
	cases := map[string]struct {
		origin, project string
		readOnly        bool
	}{
		"https://cp.example.internal/api/mcp":                      {origin: "https://cp.example.internal/"},
		"https://cp.example.internal/api/mcp?readonly":             {origin: "https://cp.example.internal", readOnly: true},
		"https://cp.example.internal/api/mcp?project=p1":           {origin: "https://cp.example.internal", project: "p1"},
		"https://cp.example.internal/api/mcp?readonly&project=a+b": {origin: "https://cp.example.internal", project: "a b", readOnly: true},
	}
	for want, c := range cases {
		if got := agentSetupMCPURL(c.origin, c.project, c.readOnly); got != want {
			t.Errorf("agentSetupMCPURL(%+v) = %q, want %q", c, got, want)
		}
	}
}

func TestAgentDetector(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A file where the directory would be is not an installed agent.
	if err := os.WriteFile(filepath.Join(home, ".codex"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	d := agentDetector{
		home: home,
		lookPath: func(name string) (string, error) {
			if name == "claude" {
				return "/usr/local/bin/claude", nil
			}
			return "", errors.New("not found")
		},
	}
	for _, c := range agentSetupClients {
		want := c.ID == "claude-code" || c.ID == "cursor"
		if got := d.installed(c); got != want {
			t.Errorf("%s installed = %v, want %v", c.ID, got, want)
		}
	}
	// The zero value reads the real PATH and home; it must answer without failing.
	_ = agentDetector{}.installed(agentSetupClients[0])
}

func TestAgentSetupChosenClients(t *testing.T) {
	prevNoInput := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prevNoInput })
	none := agentDetector{home: t.TempDir(), lookPath: func(string) (string, error) { return "", errors.New("no") }}
	got, err := agentSetupChosenClients([]string{"Codex", " vscode ", "codex"}, none)
	if err != nil || len(got) != 2 || got[0].ID != "codex" || got[1].ID != "vscode" {
		t.Errorf("named clients: %+v, %v", got, err)
	}
	if _, err := agentSetupChosenClients([]string{"emacs"}, none); clierr.From(err).Exit != clierr.ExitUsage ||
		!strings.Contains(err.Error(), "claude-code, cursor, codex, vscode") {
		t.Errorf("an unknown client: %v", err)
	}
	if _, err := agentSetupChosenClients(nil, none); clierr.From(err).Exit != clierr.ExitInputRequired {
		t.Errorf("nothing found and nothing named: %v", err)
	}
	found := agentDetector{home: t.TempDir(), lookPath: func(name string) (string, error) {
		if name == "code" {
			return "/bin/code", nil
		}
		return "", errors.New("no")
	}}
	if got, err := agentSetupChosenClients(nil, found); err != nil || len(got) != 1 || got[0].ID != "vscode" {
		t.Errorf("the detected agent: %+v, %v", got, err)
	}

	// On a terminal the detected agents are preselected, and the answer is used.
	projTTY(t)
	prev := runHuhForm
	t.Cleanup(func() { runHuhForm = prev })
	runHuhForm = func(...*huh.Group) error { return nil }
	if got, err := agentSetupChosenClients(nil, found); err != nil || len(got) != 1 || got[0].ID != "vscode" {
		t.Errorf("an unchanged choice keeps the detected agent: %+v, %v", got, err)
	}
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if _, err := agentSetupChosenClients(nil, found); !errors.Is(err, errBoom) {
		t.Errorf("a dismissed choice: %v", err)
	}
}

// setupProjects is a projectLister over a fixed list.
type setupProjects struct {
	configs []types.ConfigurationSummary
	err     error
}

func (s setupProjects) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return s.configs, s.err
}

func TestAgentSetupProjectID(t *testing.T) {
	list := setupProjects{configs: []types.ConfigurationSummary{{ID: "p1", ProjectName: "web"}}}
	if id, err := agentSetupProjectID(list, "web"); err != nil || id != "p1" {
		t.Errorf("by name: %q, %v", id, err)
	}
	// Nothing to offer, or a list that cannot be read: unpinned, without a question.
	if id, err := agentSetupProjectID(setupProjects{err: errBoom}, ""); err != nil || id != "" {
		t.Errorf("an unreadable list: %q, %v", id, err)
	}
	if id, err := agentSetupProjectID(setupProjects{}, ""); err != nil || id != "" {
		t.Errorf("no projects: %q, %v", id, err)
	}
	prev := runHuhForm
	t.Cleanup(func() { runHuhForm = prev })
	asked := 0
	runHuhForm = func(...*huh.Group) error { asked++; return nil }
	if id, err := agentSetupProjectID(list, ""); err != nil || id != "" || asked != 1 {
		t.Errorf("the default answer is every project: %q, %v (asked %d)", id, err, asked)
	}
}

func TestJSONServerWriter_KeepsEverythingElse(t *testing.T) {
	write := jsonServerWriter("mcpServers", true)
	out, err := write([]byte(`{"mcpServers":{"other":{"url":"x"}},"theme":"dark"}`), "https://cp/api/mcp")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	servers := doc["mcpServers"].(map[string]any)
	alethia := servers["alethia"].(map[string]any)
	if servers["other"] == nil || doc["theme"] != "dark" || alethia["url"] != "https://cp/api/mcp" || alethia["type"] != "http" {
		t.Errorf("got %s", out)
	}
	// Without the type key, for the agents that do not read it.
	out, _ = jsonServerWriter("mcpServers", false)(nil, "u")
	if strings.Contains(string(out), `"type"`) || !strings.HasSuffix(string(out), "}\n") {
		t.Errorf("got %s", out)
	}
	if _, err := write([]byte("{not json"), "u"); err == nil || !strings.Contains(err.Error(), "left as it is") {
		t.Errorf("invalid JSON must be refused: %v", err)
	}
	if _, err := write([]byte(`{"mcpServers":[1]}`), "u"); err == nil || !strings.Contains(err.Error(), "not an object") {
		t.Errorf("a servers key that is not an object must be refused: %v", err)
	}
}

func TestCodexServerWriter_ReplacesOnlyItsTable(t *testing.T) {
	out, _ := codexServerWriter(nil, "https://cp/api/mcp")
	if string(out) != "[mcp_servers.alethia]\nurl = \"https://cp/api/mcp\"\n" {
		t.Errorf("a new file: %q", out)
	}
	current := "model = \"o4\"\n\n[mcp_servers.alethia]\nurl = \"old\"\nenabled = true\n\n[mcp_servers.other]\nurl = \"x\"\n"
	out, _ = codexServerWriter([]byte(current), "new")
	want := "model = \"o4\"\n\n[mcp_servers.alethia]\nurl = \"new\"\n[mcp_servers.other]\nurl = \"x\"\n"
	if string(out) != want {
		t.Errorf("got:\n%s\nwant:\n%s", out, want)
	}
	out, _ = codexServerWriter([]byte("model = \"o4\""), "u")
	if string(out) != "model = \"o4\"\n\n[mcp_servers.alethia]\nurl = \"u\"\n" {
		t.Errorf("appended: %q", out)
	}
}

func TestMergeAgentsMD(t *testing.T) {
	if got := string(mergeAgentsMD(nil)); got != agentsMDSection {
		t.Errorf("a new file is the section: %q", got)
	}
	got := string(mergeAgentsMD([]byte("# Rules\nBe kind.")))
	if !strings.HasPrefix(got, "# Rules\nBe kind.\n\n"+agentsMDBegin) {
		t.Errorf("appended: %q", got)
	}
	replaced := string(mergeAgentsMD([]byte("# Rules\n" + agentsMDBegin + "\nold\n" + agentsMDEnd + "\n# After\n")))
	if replaced != "# Rules\n"+agentsMDSection+"# After\n" || strings.Contains(replaced, "old") {
		t.Errorf("replaced: %q", replaced)
	}
	if again := string(mergeAgentsMD([]byte(got))); again != got {
		t.Errorf("a second run changed the file:\n%s", again)
	}
}

func TestAgentSetupPlan_WritesThenLeavesUnchanged(t *testing.T) {
	dir := t.TempDir()
	codex, _ := agentSetupClientByID("codex")
	claude, _ := agentSetupClientByID("claude-code")
	plan := agentSetupPlan{Dir: dir, Clients: []agentSetupClient{claude, codex}, MCPURL: "https://cp/api/mcp", AgentsMD: true}

	dry := plan
	dry.DryRun = true
	r, err := dry.apply()
	if err != nil || len(r.Files) != 3 || r.Files[0].Action != ResultCreated {
		t.Fatalf("dry run: %+v, %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".mcp.json")); !errors.Is(err, os.ErrNotExist) {
		t.Error("a dry run wrote a file")
	}

	r, err = plan.apply()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range r.Files {
		if f.Action != ResultCreated {
			t.Errorf("first run: %+v", f)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".codex", "config.toml")); !strings.Contains(string(b), "https://cp/api/mcp") {
		t.Errorf("codex config: %s", b)
	}
	r, _ = plan.apply()
	for _, f := range r.Files {
		if f.Action != ResultUnchanged {
			t.Errorf("second run: %+v", f)
		}
	}
	plan.MCPURL = "https://cp/api/mcp?readonly"
	r, _ = plan.apply()
	if r.Files[0].Action != ResultUpdated || r.Files[2].Action != ResultUnchanged {
		t.Errorf("a changed URL: %+v", r.Files)
	}
	dry = plan
	dry.DryRun = true
	dry.MCPURL = "https://cp/api/mcp?project=p1"
	if r, _ = dry.apply(); r.Files[0].Action != ResultUpdated {
		t.Errorf("a dry run over an existing file: %+v", r.Files)
	}

	// A file that cannot be merged is named and left alone.
	if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := plan.apply(); err == nil || !strings.Contains(err.Error(), "Claude Code") {
		t.Errorf("a broken file: %v", err)
	}
	// A path that cannot be read or written.
	blocked := agentSetupPlan{Dir: filepath.Join(dir, "AGENTS.md"), Clients: []agentSetupClient{claude}, MCPURL: "u"}
	if _, err := blocked.apply(); err == nil {
		t.Error("a directory that is a file must fail")
	}
	notDir := agentSetupPlan{Dir: dir, AgentsMD: true}
	if err := os.Remove(filepath.Join(dir, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "AGENTS.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := notDir.apply(); err == nil || !strings.Contains(err.Error(), "AGENTS.md") {
		t.Errorf("an AGENTS.md that is a directory: %v", err)
	}
}

func TestAgentSetup_TheCommand(t *testing.T) {
	agentSetupReset(t)
	s := &projServer{}
	h := projEnv(t, s)
	dir := t.TempDir()

	code, stdout, stderr := projExitCode(t, h, "agent", "setup", "--client", "cursor", "--project", "web",
		"--read-only", "--dir", dir, "--no-input", "--output", "json")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	var got struct {
		Action string           `json:"action"`
		Object agentSetupResult `json:"object"`
	}
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("%v: %s", err, stdout)
	}
	if got.Action != "updated" || !strings.HasSuffix(got.Object.MCPURL, "/api/mcp?readonly&project=p1") || len(got.Object.Files) != 2 {
		t.Errorf("result: %+v", got)
	}
	b, _ := os.ReadFile(filepath.Join(dir, ".cursor", "mcp.json"))
	if !strings.Contains(string(b), got.Object.MCPURL) {
		t.Errorf("cursor config: %s", b)
	}
	if strings.Contains(string(b), "token") || strings.Contains(string(b), "Bearer") {
		t.Errorf("setup must write no credential: %s", b)
	}

	// Again, for a person, as a dry run: everything is unchanged and it says nothing was written.
	agentSetupReset(t)
	code, stdout, _ = projExitCode(t, h, "agent", "setup", "--client", "cursor", "--project", "web", "--read-only",
		"--dir", dir, "--no-input", "--dry-run")
	if code != 0 || !strings.Contains(stdout, "unchanged") || !strings.Contains(stdout, "Dry run") {
		t.Errorf("exit %d:\n%s", code, stdout)
	}
	agentSetupReset(t)
	code, stdout, _ = projExitCode(t, h, "agent", "setup", "--client", "vscode", "--dir", dir, "--no-agents-md", "--no-input", "--dry-run")
	if code != 0 || !strings.Contains(stdout, "would be created") {
		t.Errorf("exit %d:\n%s", code, stdout)
	}
	agentSetupReset(t)
	code, stdout, _ = projExitCode(t, h, "agent", "setup", "--client", "vscode", "--dir", dir, "--no-agents-md", "--no-input")
	if code != 0 || !strings.Contains(stdout, "sign in") {
		t.Errorf("exit %d:\n%s", code, stdout)
	}

	// Without --dir it writes into the working directory; a refusal exits with its code.
	agentSetupReset(t)
	t.Chdir(t.TempDir())
	if code, _, _ := projExitCode(t, h, "agent", "setup", "--client", "nope", "--no-input"); code != clierr.ExitUsage {
		t.Errorf("an unknown client exits %d, want 8", code)
	}
	agentSetupReset(t)
	if code, _, stderr := projExitCode(t, h, "agent", "setup", "--client", "codex", "--project", "missing", "--no-input"); code == 0 {
		t.Errorf("a project that does not exist must be refused:\n%s", stderr)
	}
	agentSetupReset(t)
	if code, _, stderr := projExitCode(t, h, "agent", "setup", "--client", "codex", "--no-input"); code != 0 {
		t.Errorf("exit %d:\n%s", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(".codex", "config.toml")); err != nil {
		t.Errorf("setup did not write into the working directory: %v", err)
	}
}

func TestAgentDetector_NoHomeDirectory(t *testing.T) {
	t.Setenv("HOME", "")
	d := agentDetector{lookPath: func(string) (string, error) { return "", errors.New("no") }}
	if d.installed(agentSetupClients[0]) {
		t.Error("with no home directory and nothing on PATH, nothing is installed")
	}
}

func TestAgentSetupPlan_ADirectoryThatCannotBeWritten(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes through directory permissions")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	cursor, _ := agentSetupClientByID("cursor")
	claude, _ := agentSetupClientByID("claude-code")
	for _, c := range []agentSetupClient{cursor, claude} {
		plan := agentSetupPlan{Dir: dir, Clients: []agentSetupClient{c}, MCPURL: "u"}
		if _, err := plan.apply(); err == nil || !strings.Contains(err.Error(), c.Name) {
			t.Errorf("%s into a read-only directory: %v", c.Name, err)
		}
	}
}

func TestAgentSetup_PinningNeedsASignIn(t *testing.T) {
	agentSetupReset(t)
	h := projEnv(t, &projServer{})
	creds, err := getCredentialsPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(creds); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := projExitCode(t, h, "agent", "setup", "--client", "codex", "--project", "web",
		"--dir", t.TempDir(), "--no-input"); code == 0 || !strings.Contains(stderr, "authentication required") {
		t.Errorf("exit %d:\n%s", code, stderr)
	}
}

func TestAgentSetup_AFileItCannotMergeIsRefused(t *testing.T) {
	agentSetupReset(t)
	h := projEnv(t, &projServer{})
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := projExitCode(t, h, "agent", "setup", "--client", "claude-code", "--dir", dir, "--no-input"); code == 0 ||
		!strings.Contains(stderr, "not valid JSON") {
		t.Errorf("exit %d:\n%s", code, stderr)
	}
}
