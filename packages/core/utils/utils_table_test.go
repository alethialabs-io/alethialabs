// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package utils

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCheckDependenciesTable table-tests CheckDependencies across mixes of
// present commands ("echo"/"ls" are POSIX-ubiquitous on the test host) and
// guaranteed-absent ones, asserting both the nil/non-nil error and that every
// missing command is named in the error message.
func TestCheckDependenciesTable(t *testing.T) {
	tests := []struct {
		name        string
		commands    []string
		wantErr     bool
		wantMissing []string // substrings that must appear in the error
	}{
		{
			name:     "empty list is satisfied",
			commands: nil,
			wantErr:  false,
		},
		{
			name:     "single present command",
			commands: []string{"echo"},
			wantErr:  false,
		},
		{
			name:     "multiple present commands",
			commands: []string{"echo", "ls"},
			wantErr:  false,
		},
		{
			name:        "single missing command",
			commands:    []string{"alethia-bogus-cmd-aaa"},
			wantErr:     true,
			wantMissing: []string{"alethia-bogus-cmd-aaa"},
		},
		{
			name:        "missing among present",
			commands:    []string{"echo", "alethia-bogus-cmd-bbb", "ls"},
			wantErr:     true,
			wantMissing: []string{"alethia-bogus-cmd-bbb"},
		},
		{
			name:        "multiple missing reported together",
			commands:    []string{"alethia-bogus-cmd-ccc", "alethia-bogus-cmd-ddd"},
			wantErr:     true,
			wantMissing: []string{"alethia-bogus-cmd-ccc", "alethia-bogus-cmd-ddd"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckDependencies(tt.commands...)
			if tt.wantErr && err == nil {
				t.Fatalf("CheckDependencies(%v) = nil, want error", tt.commands)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("CheckDependencies(%v) = %v, want nil", tt.commands, err)
			}
			if err == nil {
				return
			}
			for _, want := range tt.wantMissing {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not mention missing command %q", err.Error(), want)
				}
			}
		})
	}
}

// TestCheckDependenciesMissingOrderPreserved verifies missing commands appear in
// the order they were passed, joined by ", " (the documented format).
func TestCheckDependenciesMissingOrderPreserved(t *testing.T) {
	err := CheckDependencies("zzz-missing-1", "echo", "zzz-missing-2")
	if err == nil {
		t.Fatal("expected error for missing commands")
	}
	idx1 := strings.Index(err.Error(), "zzz-missing-1")
	idx2 := strings.Index(err.Error(), "zzz-missing-2")
	if idx1 == -1 || idx2 == -1 {
		t.Fatalf("both missing commands should be present, got: %v", err)
	}
	if idx1 >= idx2 {
		t.Errorf("expected zzz-missing-1 before zzz-missing-2 in %q", err.Error())
	}
	if !strings.Contains(err.Error(), "zzz-missing-1, zzz-missing-2") {
		t.Errorf("expected comma-joined missing list, got: %q", err.Error())
	}
}

// TestExecuteCommandWithOutputTable table-tests ExecuteCommandWithOutput's
// stdout capture, env injection, working-directory honoring, and error path
// (stderr surfaced in the wrapped error). Uses bash, present on the test host.
func TestExecuteCommandWithOutputTable(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "marker.txt"), []byte("x"), 0o600); err != nil {
		t.Fatalf("setup: %v", err)
	}

	tests := []struct {
		name        string
		command     string
		dir         string
		env         []string
		wantErr     bool
		wantOut     string // exact, after TrimSpace
		wantErrText string // substring expected in the error
	}{
		{
			name:    "echo to stdout",
			command: "echo hello",
			wantOut: "hello",
		},
		{
			name:    "env var injected",
			command: "echo $ALETHIA_TEST_VAR",
			env:     []string{"ALETHIA_TEST_VAR=injected"},
			wantOut: "injected",
		},
		{
			name:    "runs in working directory",
			command: "cat marker.txt",
			dir:     dir,
			wantOut: "x",
		},
		{
			name:        "non-zero exit returns error",
			command:     "exit 7",
			wantErr:     true,
			wantErrText: "command failed",
		},
		{
			name:        "stderr surfaced in error",
			command:     "echo boom >&2; exit 1",
			wantErr:     true,
			wantErrText: "boom",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := ExecuteCommandWithOutput(tt.command, tt.dir, tt.env)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ExecuteCommandWithOutput(%q) = nil error, want error", tt.command)
				}
				if tt.wantErrText != "" && !strings.Contains(err.Error(), tt.wantErrText) {
					t.Errorf("error %q does not contain %q", err.Error(), tt.wantErrText)
				}
				return
			}
			if err != nil {
				t.Fatalf("ExecuteCommandWithOutput(%q) unexpected error: %v", tt.command, err)
			}
			if got := strings.TrimSpace(out); got != tt.wantOut {
				t.Errorf("ExecuteCommandWithOutput(%q) = %q, want %q", tt.command, got, tt.wantOut)
			}
		})
	}
}

// TestExecuteCommandWriters table-tests ExecuteCommand routing of stdout/stderr
// to caller-supplied writers, env injection, working-directory honoring, and
// the non-zero exit error path.
func TestExecuteCommandWriters(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "data.txt"), []byte("from-dir"), 0o600); err != nil {
		t.Fatalf("setup: %v", err)
	}

	tests := []struct {
		name     string
		command  string
		dir      string
		env      []string
		wantErr  bool
		wantOut  string // exact, after TrimSpace
		wantErrW string // exact, after TrimSpace (stderr writer)
	}{
		{
			name:    "stdout captured to writer",
			command: "echo to-stdout",
			wantOut: "to-stdout",
		},
		{
			name:     "stderr captured to writer",
			command:  "echo to-stderr >&2",
			wantErrW: "to-stderr",
		},
		{
			name:    "env injected",
			command: "echo $ALETHIA_EXEC_VAR",
			env:     []string{"ALETHIA_EXEC_VAR=present"},
			wantOut: "present",
		},
		{
			name:    "working directory honored",
			command: "cat data.txt",
			dir:     dir,
			wantOut: "from-dir",
		},
		{
			name:    "non-zero exit returns error",
			command: "exit 3",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var outBuf, errBuf bytes.Buffer
			err := ExecuteCommand(tt.command, tt.dir, tt.env, &outBuf, &errBuf)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ExecuteCommand(%q) = nil error, want error", tt.command)
				}
				if !strings.Contains(err.Error(), "non-zero exit code") {
					t.Errorf("error %q does not mention non-zero exit code", err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("ExecuteCommand(%q) unexpected error: %v", tt.command, err)
			}
			if got := strings.TrimSpace(outBuf.String()); got != tt.wantOut {
				t.Errorf("stdout = %q, want %q", got, tt.wantOut)
			}
			if got := strings.TrimSpace(errBuf.String()); got != tt.wantErrW {
				t.Errorf("stderr = %q, want %q", got, tt.wantErrW)
			}
		})
	}
}
