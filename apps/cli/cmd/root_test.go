// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"slices"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

// processCommandLine is commandLine as the program ships it, taken before any test points it at an
// invocation of its own (execRootArgs does).
var processCommandLine = commandLine

// TestCommandLine_IsTheProcessArguments pins what Execute reads when nothing has replaced it: the
// arguments the process was started with, without the program name.
func TestCommandLine_IsTheProcessArguments(t *testing.T) {
	if got := processCommandLine(); !slices.Equal(got, os.Args[1:]) {
		t.Errorf("commandLine() = %v, want %v", got, os.Args[1:])
	}
}

// TestRefusalFormat_ReadsTheWholeLine pins the format a refusal from cobra is rendered in, from
// the command line alone: an explicit --output wherever it stands, then the agent default.
func TestRefusalFormat_ReadsTheWholeLine(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		env  map[string]string
		want string
	}{
		{"nothing given", []string{"nope"}, nil, ui.FormatTable},
		{"--output json before the command", []string{"--output", "json", "nope"}, nil, ui.FormatJSON},
		{"-o json after the command", []string{"nope", "-o", "json"}, nil, ui.FormatJSON},
		{"--output=json", []string{"nope", "--output=json"}, nil, ui.FormatJSON},
		{"past a flag the scan does not know", []string{"jobs", "list", "--bogus", "x", "-o", "json"}, nil, ui.FormatJSON},
		{"csv is a format too", []string{"nope", "-o", "csv"}, nil, ui.FormatCSV},
		{"a value that is not a format is not one", []string{"cluster", "kubeconfig", "--output", "kube.yaml", "--bogus"}, nil, ui.FormatTable},
		{"--agent yes", []string{"nope", "--agent", "yes"}, nil, ui.FormatJSON},
		{"an agent marker in the environment", []string{"nope"}, map[string]string{"CLAUDECODE": "1"}, ui.FormatJSON},
		{"ALETHIA_AGENT=yes", []string{"nope"}, map[string]string{AgentEnv: "yes"}, ui.FormatJSON},
		{"--agent no beats the marker", []string{"nope", "--agent", "no"}, map[string]string{"CLAUDECODE": "1"}, ui.FormatTable},
		{"an explicit table beats agent mode", []string{"nope", "-o", "table", "--agent", "yes"}, nil, ui.FormatTable},
		{"an agent that named a value that is not a format", []string{"nope", "-o", "yaml"}, map[string]string{"AI_AGENT": "1"}, ui.FormatJSON},
		{"an agent setting that cannot be read", []string{"nope"}, map[string]string{AgentEnv: "sometimes"}, ui.FormatTable},
		{"a value the scan cannot read", []string{"nope", "--debug=sometimes", "-o", "json"}, nil, ui.FormatTable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetFlagsAroundTest(t)
			modeEnv(t, tc.env)
			if got := refusalFormat(tc.args); got != tc.want {
				t.Errorf("refusalFormat(%v) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
}

// TestRefusalFormat_WhatCobraParsedCounts pins the other source: a flag cobra had already parsed
// when it refused is honoured even when the line handed to the scan does not carry it.
func TestRefusalFormat_WhatCobraParsedCounts(t *testing.T) {
	resetFlagsAroundTest(t)
	modeEnv(t, nil)
	if err := rootCmd.PersistentFlags().Set("output", ui.FormatJSON); err != nil {
		t.Fatal(err)
	}
	if got := refusalFormat(nil); got != ui.FormatJSON {
		t.Errorf("refusalFormat = %q, want the format cobra parsed", got)
	}
}

// TestExecute_AnAgentIsRefusedInJSON drives the whole path for the two refusals cobra makes: in
// agent mode, with no --output on the line, each is one envelope on stderr and nothing on stdout.
func TestExecute_AnAgentIsRefusedInJSON(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		code string
	}{
		{"an unknown command", []string{"definitely-not-a-command"}, clierr.CodeInvalidUsage},
		{"an unknown flag", []string{"version", "--definitely-not-a-flag"}, clierr.CodeInvalidFlag},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetFlagsAroundTest(t)
			modeEnv(t, map[string]string{"CLAUDECODE": "1"})
			stdout, stderr, code := hygCliStdoutFatal(t, func() {
				execRootArgs(tc.args)
				Execute()
			})
			if stdout != "" {
				t.Errorf("stdout is not empty: %q", stdout)
			}
			gotCode, gotExit := hygCliStdoutEnvelope(t, stderr)
			if code != clierr.ExitUsage || gotExit != clierr.ExitUsage || gotCode != tc.code {
				t.Errorf("exit=%d envelope exit_code=%d code=%q", code, gotExit, gotCode)
			}
		})
	}
}

// TestExecute_AppliesTheRegistry pins that the tree a person runs is the grouped one: Execute
// writes the registry onto it before cobra reads it.
func TestExecute_AppliesTheRegistry(t *testing.T) {
	resetFlagsAroundTest(t)
	loginCmd.GroupID = ""
	stdout, _ := captureStreams(t, func() {
		execRootArgs([]string{"version"})
		Execute()
	})
	if loginCmd.GroupID != groupStart {
		t.Errorf("Execute left `login` in help group %q, want %q", loginCmd.GroupID, groupStart)
	}
	if stdout == "" {
		t.Error("`version` printed nothing")
	}
}

// TestRoot_TheUpdateNoticeIsForAPerson pins who the upgrade notice is shown to: not an agent, and
// not a command that opts out of it.
func TestRoot_TheUpdateNoticeIsForAPerson(t *testing.T) {
	prevCheck, prevPrinter := checkForUpdate, printer
	t.Cleanup(func() { checkForUpdate, printer = prevCheck, prevPrinter })
	checks := 0
	checkForUpdate = func(string, string) { checks++ }

	plain := &cobra.Command{Use: "plain"}
	optedOut := &cobra.Command{Use: "quiet", Annotations: map[string]string{skipUpdateNoticeAnnotation: "true"}}

	printer = newPrinter(ui.FormatTable, Mode{Color: true})
	rootCmd.PersistentPostRun(plain, nil)
	if checks != 1 {
		t.Fatalf("a person's command made %d update checks, want 1", checks)
	}
	rootCmd.PersistentPostRun(optedOut, nil)
	if checks != 1 {
		t.Errorf("a command that opts out of the notice still checked for an update")
	}

	printer = newPrinter(ui.FormatJSON, Mode{Agent: true, NoInput: true})
	rootCmd.PersistentPostRun(plain, nil)
	if checks != 1 {
		t.Errorf("an agent's command checked for an update")
	}
}
