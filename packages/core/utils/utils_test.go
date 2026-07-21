// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package utils

import (
	"strings"
	"testing"
)

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"app.yaml":            `'app.yaml'`,
		"":                    `''`,
		"a b":                 `'a b'`,
		"x; rm -rf /":         `'x; rm -rf /'`,
		"$(touch /tmp/pwned)": `'$(touch /tmp/pwned)'`,
		"`id`":                "'`id`'",
		"it's":                `'it'\''s'`,
		"a'b'c":               `'a'\''b'\''c'`,
	}
	for in, want := range cases {
		if got := ShellQuote(in); got != want {
			t.Errorf("ShellQuote(%q) = %q, want %q", in, got, want)
		}
	}
	// Round-trip: a quoted string handed to `bash -c echo` yields the original verbatim.
	for in := range cases {
		out, err := ExecuteCommandWithOutput("printf %s "+ShellQuote(in), ".", nil)
		if err != nil {
			t.Fatalf("ExecuteCommandWithOutput(%q): %v", in, err)
		}
		if out != in {
			t.Errorf("round-trip of %q via bash printf = %q", in, out)
		}
	}
}

func TestCheckDependenciesFindsInstalledCommands(t *testing.T) {
	err := CheckDependencies("echo", "ls")
	if err != nil {
		t.Errorf("expected no error for common commands, got: %v", err)
	}
}

func TestCheckDependenciesReportsMissing(t *testing.T) {
	err := CheckDependencies("nonexistent-command-xyz-123")
	if err == nil {
		t.Fatal("expected error for missing command")
	}
	if !strings.Contains(err.Error(), "nonexistent-command-xyz-123") {
		t.Errorf("error should mention the missing command, got: %v", err)
	}
}

func TestCheckDependenciesReportsMultipleMissing(t *testing.T) {
	err := CheckDependencies("missing-cmd-a", "echo", "missing-cmd-b")
	if err == nil {
		t.Fatal("expected error for missing commands")
	}
	if !strings.Contains(err.Error(), "missing-cmd-a") || !strings.Contains(err.Error(), "missing-cmd-b") {
		t.Errorf("error should mention both missing commands, got: %v", err)
	}
}

func TestCheckDependenciesEmptyList(t *testing.T) {
	err := CheckDependencies()
	if err != nil {
		t.Errorf("expected no error for empty list, got: %v", err)
	}
}

func TestExecuteCommandWithOutputCaptures(t *testing.T) {
	output, err := ExecuteCommandWithOutput("echo hello", "", nil)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if strings.TrimSpace(output) != "hello" {
		t.Errorf("expected 'hello', got: %q", output)
	}
}

func TestExecuteCommandWithOutputFails(t *testing.T) {
	_, err := ExecuteCommandWithOutput("exit 1", "", nil)
	if err == nil {
		t.Fatal("expected error for failing command")
	}
}
