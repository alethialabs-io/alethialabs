// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

// TestRequestAppsRefresh pins the refresh command and that a failure is a warning, not an error.
func TestRequestAppsRefresh(t *testing.T) {
	prev := executeCommand
	t.Cleanup(func() { executeCommand = prev })

	var got []string
	executeCommand = func(cmd, _ string, _ []string, _, _ io.Writer) error {
		got = append(got, cmd)
		return nil
	}
	var out, errb bytes.Buffer
	requestAppsRefresh(&out, &errb)
	if len(got) != 1 || got[0] != appsRefreshCommand {
		t.Fatalf("ran %q, want exactly %q", got, appsRefreshCommand)
	}
	for _, want := range []string{"applications.argoproj.io/apps", "-n argocd", "argocd.argoproj.io/refresh=normal", "--overwrite"} {
		if !strings.Contains(appsRefreshCommand, want) {
			t.Errorf("refresh command %q lacks %q", appsRefreshCommand, want)
		}
	}
	if !strings.Contains(out.String(), "re-read the apps repo") || errb.Len() != 0 {
		t.Errorf("success path: stdout=%q stderr=%q", out.String(), errb.String())
	}

	executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return errors.New("boom") }
	out.Reset()
	errb.Reset()
	requestAppsRefresh(&out, &errb)
	if !strings.Contains(errb.String(), "Warning: could not ask ArgoCD") || !strings.Contains(errb.String(), "boom") {
		t.Errorf("failure path must warn with the cause, got stderr=%q", errb.String())
	}
	if out.Len() != 0 {
		t.Errorf("failure path must not claim success, got stdout=%q", out.String())
	}
}
