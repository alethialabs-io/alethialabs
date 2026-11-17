// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

// The suite runs with an EMPTY environment as far as resolveMode can see.
//
// A test process inherits the environment of whatever started it, and an agent harness sets the
// very markers agentMarkers lists. Left alone, every command-level test in this package would run
// in agent mode when the suite is started from one — json by default, prompts refused — and in
// person mode in CI. A test that wants a variable installs its own lookup with modeEnv.
func init() {
	lookupEnv = func(string) (string, bool) { return "", false }
}

// modeEnv installs a fixed environment for resolveMode and puts back whatever was there.
func modeEnv(t *testing.T, env map[string]string) {
	t.Helper()
	prev := lookupEnv
	lookupEnv = func(name string) (string, bool) {
		v, ok := env[name]
		return v, ok
	}
	t.Cleanup(func() { lookupEnv = prev })
}

// modeStdin stubs whether stdin is a terminal.
func modeStdin(t *testing.T, tty bool) {
	t.Helper()
	prev := stdinIsTTY
	stdinIsTTY = func() bool { return tty }
	t.Cleanup(func() { stdinIsTTY = prev })
}

// modeRoot builds a root command carrying the real global flags, parsed from args. It is a fresh
// tree, so nothing a test sets on it reaches the package's shared rootCmd.
func modeRoot(t *testing.T, args ...string) *cobra.Command {
	t.Helper()
	prevToken, prevOrg := serviceTokenFlag, orgFlag
	t.Cleanup(func() { serviceTokenFlag, orgFlag = prevToken, prevOrg })

	root := &cobra.Command{Use: "alethia"}
	registerShellGlobalFlags(root)
	if err := root.ParseFlags(args); err != nil {
		t.Fatalf("parse %v: %v", args, err)
	}
	return root
}

// modeState restores every package global resolveInputMode assigns.
func modeState(t *testing.T) {
	t.Helper()
	prevPrinter, prevNoInput, prevFormat, prevExit := printer, noInputMode, errorFormat, exitFunc
	t.Cleanup(func() {
		printer, noInputMode, errorFormat, exitFunc = prevPrinter, prevNoInput, prevFormat, prevExit
	})
}

// modeStderr redirects os.Stderr into a buffer the returned function reads.
func modeStderr(t *testing.T) func() string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stderr
	os.Stderr = w
	t.Cleanup(func() { os.Stderr = prev })
	return func() string {
		w.Close()
		b, _ := io.ReadAll(r)
		return string(b)
	}
}

// TestAgentMarkers_EachOneSelectsAgentMode ranges over the marker list itself, so a marker added to
// it is covered by being written, and one removed stops being asserted.
func TestAgentMarkers_EachOneSelectsAgentMode(t *testing.T) {
	if len(agentMarkers) == 0 {
		t.Fatal("agentMarkers is empty — auto-detection can never select agent mode")
	}
	modeStdin(t, true)
	seen := map[string]bool{}
	for _, marker := range agentMarkers {
		if seen[marker] {
			t.Errorf("%s is listed twice", marker)
		}
		seen[marker] = true

		modeEnv(t, map[string]string{marker: "1"})
		mode, err := resolveMode(modeRoot(t), lookupEnv)
		if err != nil {
			t.Fatalf("%s: %v", marker, err)
		}
		if !mode.Agent {
			t.Errorf("%s=1 did not select agent mode", marker)
		}

		modeEnv(t, map[string]string{marker: ""})
		mode, _ = resolveMode(modeRoot(t), lookupEnv)
		if mode.Agent {
			t.Errorf("an EMPTY %s selected agent mode; a marker counts only when it has a value", marker)
		}
	}
	// The five the contract names. A rename here is a change to what is detected.
	for _, want := range []string{"AGENT", "AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX", "CURSOR_AGENT"} {
		if !seen[want] {
			t.Errorf("agentMarkers no longer lists %s", want)
		}
	}
}

// TestResolveMode_Precedence pins the order: the flag, then ALETHIA_AGENT, then detection.
func TestResolveMode_Precedence(t *testing.T) {
	modeStdin(t, true)
	cases := []struct {
		name  string
		args  []string
		env   map[string]string
		agent bool
	}{
		{"nothing set", nil, nil, false},
		{"a marker alone", nil, map[string]string{"CLAUDECODE": "1"}, true},
		{"the variable turns detection off", nil, map[string]string{"CLAUDECODE": "1", AgentEnv: "no"}, false},
		{"the variable turns it on", nil, map[string]string{AgentEnv: "yes"}, true},
		{"the variable as a boolean", nil, map[string]string{AgentEnv: "1"}, true},
		{"the variable as false", nil, map[string]string{"AGENT": "x", AgentEnv: "false"}, false},
		{"the variable set to auto still detects", nil, map[string]string{"AGENT": "x", AgentEnv: "auto"}, true},
		{"an empty variable is auto", nil, map[string]string{AgentEnv: ""}, false},
		{"the flag beats the variable", []string{"--agent", "no"}, map[string]string{AgentEnv: "yes"}, false},
		{"the flag beats detection", []string{"--agent=no"}, map[string]string{"CURSOR_AGENT": "1"}, false},
		{"the flag turns it on", []string{"--agent", "yes"}, nil, true},
		{"the flag set to auto defers to the markers", []string{"--agent", "auto"}, map[string]string{"AI_AGENT": "1", AgentEnv: "no"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			modeEnv(t, tc.env)
			mode, err := resolveMode(modeRoot(t, tc.args...), lookupEnv)
			if err != nil {
				t.Fatalf("resolveMode: %v", err)
			}
			if mode.Agent != tc.agent {
				t.Errorf("Agent = %v, want %v", mode.Agent, tc.agent)
			}
		})
	}
}

// TestResolveMode_AnUnreadableSwitchIsAUsageError: neither wrong guess is acceptable, so there is
// no guess.
func TestResolveMode_AnUnreadableSwitchIsAUsageError(t *testing.T) {
	modeStdin(t, true)

	modeEnv(t, nil)
	_, err := resolveMode(modeRoot(t, "--agent", "maybe"), lookupEnv)
	if e := clierr.From(err); err == nil || e.Code != clierr.CodeInvalidFlag || e.Exit != clierr.ExitUsage {
		t.Errorf("--agent maybe: got %v, want an invalid_flag usage error", err)
	}
	if err != nil && !strings.Contains(err.Error(), `"maybe"`) {
		t.Errorf("the error does not quote the value it refused: %v", err)
	}

	modeEnv(t, map[string]string{AgentEnv: "sometimes"})
	_, err = resolveMode(modeRoot(t), lookupEnv)
	if e := clierr.From(err); err == nil || e.Code != clierr.CodeInvalidUsage || e.Exit != clierr.ExitUsage {
		t.Errorf("%s=sometimes: got %v, want an invalid_usage usage error", AgentEnv, err)
	}
	if err != nil && !strings.Contains(err.Error(), AgentEnv) {
		t.Errorf("the error does not name the variable: %v", err)
	}
}

// TestResolveMode_WhatEachModeImplies pins the fields beside Agent.
func TestResolveMode_WhatEachModeImplies(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		env      map[string]string
		stdinTTY bool
		want     Mode
	}{
		{"a person at a terminal", nil, nil, true, Mode{Color: true}},
		{"a pipe turns prompts off and nothing else", nil, nil, false, Mode{NoInput: true, Color: true}},
		{"--no-input", []string{"--no-input"}, nil, true, Mode{NoInput: true, Color: true}},
		{"an agent at a terminal is still never prompted", []string{"--agent", "yes"}, nil, true, Mode{Agent: true, NoInput: true}},
		{"NO_COLOR", nil, map[string]string{"NO_COLOR": "1"}, true, Mode{}},
		{"an empty NO_COLOR is not a request", nil, map[string]string{"NO_COLOR": ""}, true, Mode{Color: true}},
		{"TERM=dumb", nil, map[string]string{"TERM": "dumb"}, true, Mode{}},
		{"any other TERM", nil, map[string]string{"TERM": "xterm-256color"}, true, Mode{Color: true}},
		{"--debug", []string{"--debug"}, nil, true, Mode{Color: true, Debug: true}},
		{"ALETHIA_DEBUG=api", nil, map[string]string{DebugEnv: "api"}, true, Mode{Color: true, Debug: true}},
		{"ALETHIA_DEBUG in a list", nil, map[string]string{DebugEnv: "cache, API"}, true, Mode{Color: true, Debug: true}},
		{"ALETHIA_DEBUG=all", nil, map[string]string{DebugEnv: "all"}, true, Mode{Color: true, Debug: true}},
		{"ALETHIA_DEBUG=1", nil, map[string]string{DebugEnv: "1"}, true, Mode{Color: true, Debug: true}},
		{"ALETHIA_DEBUG=0", nil, map[string]string{DebugEnv: "0"}, true, Mode{Color: true}},
		{"ALETHIA_DEBUG naming another topic", nil, map[string]string{DebugEnv: "cache"}, true, Mode{Color: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			modeEnv(t, tc.env)
			modeStdin(t, tc.stdinTTY)
			got, err := resolveMode(modeRoot(t, tc.args...), lookupEnv)
			if err != nil {
				t.Fatalf("resolveMode: %v", err)
			}
			if got != tc.want {
				t.Errorf("mode = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestResolveInputMode_BuildsThePrinter drives the hook the root PersistentPreRun calls.
func TestResolveInputMode_BuildsThePrinter(t *testing.T) {
	cases := []struct {
		name        string
		args        []string
		env         map[string]string
		format      string
		errorFormat string
		noInput     bool
	}{
		{"a person gets the table", nil, nil, ui.FormatTable, ui.FormatTable, false},
		{"a person asking for json", []string{"-o", "json"}, nil, ui.FormatJSON, ui.FormatTable, false},
		{"an agent gets json by default, errors included", nil, map[string]string{"CLAUDECODE": "1"}, ui.FormatJSON, ui.FormatJSON, true},
		{"an agent that asked for the table gets it", []string{"-o", "table"}, map[string]string{"CLAUDECODE": "1"}, ui.FormatTable, ui.FormatTable, true},
		{"an agent that asked for csv gets it", []string{"--agent", "yes", "--output", "csv"}, nil, ui.FormatCSV, ui.FormatTable, true},
		{"an unknown format is left for the command to refuse", []string{"-o", "xml"}, nil, ui.FormatTable, ui.FormatTable, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			modeState(t)
			modeEnv(t, tc.env)
			modeStdin(t, true)
			errorFormat = ui.FormatTable

			resolveInputMode(modeRoot(t, tc.args...))

			if printer.Format != tc.format {
				t.Errorf("printer.Format = %q, want %q", printer.Format, tc.format)
			}
			if errorFormat != tc.errorFormat {
				t.Errorf("errorFormat = %q, want %q", errorFormat, tc.errorFormat)
			}
			if noInputMode != tc.noInput || printer.Mode.NoInput != tc.noInput {
				t.Errorf("noInputMode = %v, printer.Mode.NoInput = %v, want %v",
					noInputMode, printer.Mode.NoInput, tc.noInput)
			}
		})
	}
}

// TestResolveInputMode_ARefusedSwitchExitsAsUsage: the refusal goes down the one fatal path, on
// stderr, and the Printer of the invocation is left as it was.
func TestResolveInputMode_ARefusedSwitchExitsAsUsage(t *testing.T) {
	modeState(t)
	modeEnv(t, nil)
	modeStdin(t, true)
	read := modeStderr(t)
	code := -1
	exitFunc = func(c int) { code = c }
	before := printer

	resolveInputMode(modeRoot(t, "--agent", "perhaps"))

	if code != clierr.ExitUsage {
		t.Errorf("exit = %d, want %d", code, clierr.ExitUsage)
	}
	if printer != before {
		t.Error("a refused invocation replaced the Printer")
	}
	if got := read(); !strings.Contains(got, `invalid --agent "perhaps"`) {
		t.Errorf("stderr does not carry the refusal: %q", got)
	}
}

// TestOutputFormat_AgentDefaultAndRefusal pins the reader the list commands use.
func TestOutputFormat_AgentDefaultAndRefusal(t *testing.T) {
	modeState(t)
	modeStdin(t, true)

	modeEnv(t, map[string]string{"CODEX_SANDBOX": "1"})
	root := modeRoot(t)
	resolveInputMode(root)
	if got := outputFormat(root); got != ui.FormatJSON {
		t.Errorf("an agent with no --output read %q, want json", got)
	}

	root = modeRoot(t, "-o", "csv")
	resolveInputMode(root)
	if got := outputFormat(root); got != ui.FormatCSV {
		t.Errorf("an agent with -o csv read %q, want csv", got)
	}

	// The root PersistentPreRun records the format before it calls the resolver; this is that step.
	errorFormat = ui.FormatTable
	modeEnv(t, nil)
	root = modeRoot(t)
	resolveInputMode(root)
	if got := outputFormat(root); got != ui.FormatTable {
		t.Errorf("a person with no --output read %q, want table", got)
	}

	read := modeStderr(t)
	code := -1
	exitFunc = func(c int) { code = c }
	root = modeRoot(t, "-o", "xml")
	resolveInputMode(root)
	outputFormat(root)
	if code != clierr.ExitUsage {
		t.Errorf("an unknown --output exited %d, want %d", code, clierr.ExitUsage)
	}
	if got := read(); !strings.Contains(got, `invalid --output "xml"`) {
		t.Errorf("stderr does not carry the refusal: %q", got)
	}
}

// TestRunSpinner_AnAgentIsNeverShownOne: the terminal check alone would draw it.
func TestRunSpinner_AnAgentIsNeverShownOne(t *testing.T) {
	modeState(t)
	prevTTY := interactiveOutIsTTY
	asked := false
	interactiveOutIsTTY = func() bool { asked = true; return true }
	t.Cleanup(func() { interactiveOutIsTTY = prevTTY })

	printer = &Printer{Out: io.Discard, Err: io.Discard, Format: ui.FormatJSON, Mode: Mode{Agent: true}}
	ran := false
	runSpinner("Fetching...", func() { ran = true })
	if !ran {
		t.Error("the action did not run")
	}
	if asked {
		t.Error("agent mode consulted the terminal; it must decline before that")
	}
}

// newTestPrinter is a Printer over two buffers.
func newTestPrinter(format string, mode Mode) (*Printer, *bytes.Buffer, *bytes.Buffer) {
	out, errOut := &bytes.Buffer{}, &bytes.Buffer{}
	return &Printer{Out: out, Err: errOut, Format: format, Mode: mode}, out, errOut
}

// TestPrinter_ResultNeverMixesTheForms: one format, one writer, and the human sentence only for a
// person.
func TestPrinter_ResultNeverMixesTheForms(t *testing.T) {
	res := MutationResult{
		ID: "prj_1", Kind: "project", Action: ResultQueued,
		Job: &JobRef{ID: "job_1", Type: "DEPLOY"},
	}
	human := func(w io.Writer) { ui.SuccessTo(w, "Queued a deploy") }

	p, out, errOut := newTestPrinter(ui.FormatTable, Mode{})
	if err := p.Result(res, human); err != nil {
		t.Fatalf("table: %v", err)
	}
	if !strings.Contains(out.String(), "Queued a deploy") || strings.Contains(out.String(), `"id"`) {
		t.Errorf("table form = %q", out.String())
	}
	if errOut.Len() != 0 {
		t.Errorf("a result wrote to Err: %q", errOut.String())
	}

	p, out, errOut = newTestPrinter(ui.FormatJSON, Mode{})
	if err := p.Result(res, human); err != nil {
		t.Fatalf("json: %v", err)
	}
	var got MutationResult
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("the json form does not parse: %v\n%s", err, out.String())
	}
	if got.ID != "prj_1" || got.Action != ResultQueued || got.Job == nil || got.Job.ID != "job_1" {
		t.Errorf("round-trip = %+v", got)
	}
	if strings.Contains(out.String(), "Queued a deploy") || errOut.Len() != 0 {
		t.Errorf("the sentence reached a json run: out=%q err=%q", out.String(), errOut.String())
	}

	p, out, _ = newTestPrinter(ui.FormatCSV, Mode{})
	if err := p.Result(res, human); err != nil {
		t.Fatalf("csv: %v", err)
	}
	if want := "id,kind,action,job_id,job_type,dry_run\nprj_1,project,queued,job_1,DEPLOY,false\n"; out.String() != want {
		t.Errorf("csv form = %q, want %q", out.String(), want)
	}

	// A value with no rows has no csv form, and says so as a usage error instead of printing json
	// or a sentence into a file a spreadsheet will open.
	p, out, _ = newTestPrinter(ui.FormatCSV, Mode{})
	err := p.Result(map[string]string{"k": "v"}, human)
	if !errors.Is(err, errNoCSVForm) || clierr.From(err).Exit != clierr.ExitUsage {
		t.Errorf("csv of a non-tabular value: %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("a refused csv still wrote %q", out.String())
	}

	// No sentence to say is a legal human form.
	p, out, _ = newTestPrinter(ui.FormatTable, Mode{})
	if err := p.Result(res, nil); err != nil || out.Len() != 0 {
		t.Errorf("nil human: err=%v out=%q", err, out.String())
	}
}

// TestMutationResult_EveryKeyIsAlwaysPresent pins the wire shape: a reader never has to tell an
// absent key from an empty one.
func TestMutationResult_EveryKeyIsAlwaysPresent(t *testing.T) {
	b, err := json.Marshal(MutationResult{ID: "r1", Kind: "runner", Action: ResultDeleted})
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(b, &keys); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"id", "kind", "action", "job", "dry_run", "object"} {
		if _, ok := keys[k]; !ok {
			t.Errorf("key %q is missing from %s", k, b)
		}
	}
	if len(keys) != 6 {
		t.Errorf("the shape has %d keys, want 6: %s", len(keys), b)
	}
	if string(keys["job"]) != "null" || string(keys["object"]) != "null" || string(keys["dry_run"]) != "false" {
		t.Errorf("empty values are not null/false: %s", b)
	}

	b, _ = json.Marshal(MutationResult{Job: &JobRef{ID: "j", Type: "PLAN"}, DryRun: true, Object: map[string]int{"n": 1}})
	if want := `"job":{"id":"j","type":"PLAN"},"dry_run":true,"object":{"n":1}`; !strings.Contains(string(b), want) {
		t.Errorf("a full result = %s, want it to contain %s", b, want)
	}

	// The action vocabulary is the contract's five words.
	actions := []ResultAction{ResultCreated, ResultUpdated, ResultDeleted, ResultQueued, ResultUnchanged}
	if got := strings.Join(func() []string {
		s := make([]string, len(actions))
		for i, a := range actions {
			s[i] = string(a)
		}
		return s
	}(), "|"); got != "created|updated|deleted|queued|unchanged" {
		t.Errorf("actions = %s", got)
	}

	// With no job, the csv row keeps its columns and leaves the two job cells empty.
	row := MutationResult{ID: "r1", Kind: "runner", Action: ResultDeleted, DryRun: true}.Table()
	if len(row.Rows) != 1 || len(row.Rows[0]) != len(row.Columns) {
		t.Fatalf("csv row/column mismatch: %+v", row)
	}
	if got := strings.Join(row.Rows[0], ","); got != "r1,runner,deleted,,,true" {
		t.Errorf("csv row = %q", got)
	}
}

// TestPrinter_DiagnosticsGoToErr: everything said ABOUT the run stays off the document stream.
func TestPrinter_DiagnosticsGoToErr(t *testing.T) {
	p, out, errOut := newTestPrinter(ui.FormatJSON, Mode{})
	p.Note("using the active organization")
	p.Warn("the runner is offline")
	p.Progress("Deploying web")
	p.JobQueued("DEPLOY", "job_9")
	p.Debugf("GET %s", "/api/cli/jobs")

	if out.Len() != 0 {
		t.Errorf("a diagnostic reached Out: %q", out.String())
	}
	got := errOut.String()
	for _, want := range []string{
		"using the active organization",
		"the runner is offline",
		ui.SymbolPoint + " Deploying web",
		"Queued DEPLOY job (ID: job_9)",
		"alethia jobs logs job_9 --follow",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("Err is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "debug:") {
		t.Errorf("a debug line was printed without --debug:\n%s", got)
	}

	// An agent gets the bare sentence.
	p, _, errOut = newTestPrinter(ui.FormatJSON, Mode{Agent: true})
	p.Progress("Deploying web")
	if errOut.String() != "Deploying web\n" {
		t.Errorf("agent progress = %q", errOut.String())
	}

	p, out, errOut = newTestPrinter(ui.FormatTable, Mode{Debug: true})
	p.Debugf("GET %s -> %d", "/api/cli/jobs", 200)
	if errOut.String() != "debug: GET /api/cli/jobs -> 200\n" || out.Len() != 0 {
		t.Errorf("debug line: out=%q err=%q", out.String(), errOut.String())
	}
}

// TestPrinter_TableRendersInItsFormat covers the result-set path.
func TestPrinter_TableRendersInItsFormat(t *testing.T) {
	spec := ui.TableSpec{Columns: []string{"NAME"}, Rows: [][]string{{"web"}}}
	records := []map[string]string{{"name": "web"}}

	p, out, _ := newTestPrinter(ui.FormatCSV, Mode{})
	if err := p.Table(spec, records); err != nil || out.String() != "NAME\nweb\n" {
		t.Errorf("csv: err=%v out=%q", err, out.String())
	}
	p, out, _ = newTestPrinter(ui.FormatJSON, Mode{})
	if err := p.Table(spec, records); err != nil || !strings.Contains(out.String(), `"name": "web"`) {
		t.Errorf("json: err=%v out=%q", err, out.String())
	}
}

// TestProcessPrinter_FollowsTheLiveStreams: the process Printer is built once, and a stream that is
// redirected afterwards must still receive what is written.
func TestProcessPrinter_FollowsTheLiveStreams(t *testing.T) {
	p := newPrinter(ui.FormatTable, Mode{})

	readErr := modeStderr(t)
	p.Note("to stderr")

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = prev })
	if err := p.Result(nil, func(out io.Writer) { ui.InfoTo(out, "to stdout") }); err != nil {
		t.Fatal(err)
	}
	w.Close()
	b, _ := io.ReadAll(r)

	if !strings.Contains(string(b), "to stdout") {
		t.Errorf("stdout = %q", b)
	}
	if got := readErr(); !strings.Contains(got, "to stderr") || strings.Contains(got, "to stdout") {
		t.Errorf("stderr = %q", got)
	}
}

// TestShellModeFlags_AreRegisteredFromTheirSpec holds --agent and --debug to the table that
// describes them, the way hyg_cli_shellform_test.go holds the four flags in shellFields.
func TestShellModeFlags_AreRegisteredFromTheirSpec(t *testing.T) {
	if len(shellModeFields) != 2 {
		t.Fatalf("shellModeFields has %d entries; registerShellGlobalFlags reads exactly two", len(shellModeFields))
	}
	for _, f := range shellModeFields {
		flag := rootCmd.PersistentFlags().Lookup(f.Flag)
		if flag == nil {
			t.Errorf("--%s is not a persistent flag of the root", f.Flag)
			continue
		}
		if flag.Usage != f.Usage {
			t.Errorf("--%s prints %q in --help, the spec says %q", f.Flag, flag.Usage, f.Usage)
		}
		if f.Docs == "" {
			t.Errorf("--%s has no Docs sentence for the row it is owed", f.Flag)
		}
		for _, in := range shellFields {
			if in.Command == f.Command && in.Flag == f.Flag {
				t.Errorf("--%s is in both shellFields and shellModeFields", f.Flag)
			}
		}
	}
	if def := rootCmd.PersistentFlags().Lookup(shellFlagAgent).DefValue; def != agentAuto {
		t.Errorf("--agent defaults to %q, want %q", def, agentAuto)
	}
	if def := rootCmd.PersistentFlags().Lookup(shellFlagDebug).DefValue; def != "false" {
		t.Errorf("--debug defaults to %q, want false", def)
	}
}
