// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

// fixtures live in the verify package's testdata.
func fixture(name string) string {
	return filepath.Join("..", "..", "testdata", name)
}

func TestRunBlockingExitCode(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run([]string{fixture("fail_static_key_admin.json")}, nil, &out, &errOut)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2 for a blocking plan (stderr: %s)", code, errOut.String())
	}
	if !strings.Contains(out.String(), "verdict: fail") {
		t.Errorf("human output missing verdict: %s", out.String())
	}
}

func TestRunPassExitCode(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run([]string{fixture("pass_keyless_least_priv.json")}, nil, &out, &errOut)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 for a passing plan (stderr: %s)", code, errOut.String())
	}
}

func TestRunStdin(t *testing.T) {
	in := strings.NewReader(`{"format_version":"1.2","resource_changes":[]}`)
	var out, errOut bytes.Buffer
	code := run(nil, in, &out, &errOut)
	if code != 0 {
		t.Fatalf("empty plan from stdin should pass, got %d (stderr: %s)", code, errOut.String())
	}
}

func TestRunJSONOutput(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run([]string{"-json", fixture("fail_wildcard_sub.json")}, nil, &out, &errOut)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(out.String(), `"verdict": "fail"`) {
		t.Errorf("json output missing verdict field: %s", out.String())
	}
}

func TestRunBadJSON(t *testing.T) {
	in := strings.NewReader("not json")
	var out, errOut bytes.Buffer
	if code := run(nil, in, &out, &errOut); code != 1 {
		t.Fatalf("bad JSON should exit 1, got %d", code)
	}
}
