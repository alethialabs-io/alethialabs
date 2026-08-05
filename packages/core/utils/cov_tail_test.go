// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package utils

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// TestTail_LoggerWithoutAPIClientNeverPanics pins the offline shape of the logger: with a nil
// API client every level prints and returns, so a runner with no control plane still logs.
func TestTail_LoggerWithoutAPIClientNeverPanics(t *testing.T) {
	l := NewLogger(nil, "deploy-1")
	if l.deploymentID != "deploy-1" {
		t.Fatalf("NewLogger kept deploymentID %q, want deploy-1", l.deploymentID)
	}
	if l.apiClient != nil {
		t.Fatal("NewLogger(nil) must keep a nil API client")
	}
	l.Info("informational", "step")
	l.Warn("warned", "step")
	l.Error("failed", "step")
}

// TestTail_LoggerForwardsEveryLevelToTheAPI pins that each level POSTs one log entry carrying
// the deployment id, the step and its own level string — the control plane's job log is built
// from these, so a mislabelled level is a wrong job log.
func TestTail_LoggerForwardsEveryLevelToTheAPI(t *testing.T) {
	type got struct {
		path  string
		entry api.LogEntry
	}
	var seen []got
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var e api.LogEntry
		_ = json.NewDecoder(r.Body).Decode(&e)
		seen = append(seen, got{path: r.URL.Path, entry: e})
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)

	l := NewLogger(api.NewClient("token"), "dep-42")
	l.Info("starting", "plan")
	l.Warn("careful", "plan")
	l.Error("boom", "apply")

	if len(seen) != 3 {
		t.Fatalf("the API received %d log entries, want 3", len(seen))
	}
	wantLevels := []string{"info", "warn", "error"}
	wantSteps := []string{"plan", "plan", "apply"}
	wantMessages := []string{"starting", "careful", "boom"}
	for i, g := range seen {
		if !strings.Contains(g.path, "/deployments/dep-42/logs") {
			t.Errorf("entry %d posted to %q, want the dep-42 logs endpoint", i, g.path)
		}
		if g.entry.Level != wantLevels[i] {
			t.Errorf("entry %d level = %q, want %q", i, g.entry.Level, wantLevels[i])
		}
		if g.entry.Step != wantSteps[i] {
			t.Errorf("entry %d step = %q, want %q", i, g.entry.Step, wantSteps[i])
		}
		if g.entry.Message != wantMessages[i] {
			t.Errorf("entry %d message = %q, want %q", i, g.entry.Message, wantMessages[i])
		}
	}
}

// TestTail_ExecuteCommandDefaultsNilWriters pins that nil writers fall back to the process
// stdio rather than panicking on a nil io.Writer.
func TestTail_ExecuteCommandDefaultsNilWriters(t *testing.T) {
	if err := ExecuteCommand("printf tail-default", t.TempDir(), nil, nil, nil); err != nil {
		t.Fatalf("ExecuteCommand with nil writers: %v", err)
	}
}

// TestTail_ExecuteCommandRoutesStreamsAndEnv pins that stdout and stderr go to the writers the
// caller supplied and that the custom env is layered onto the process environment.
func TestTail_ExecuteCommandRoutesStreamsAndEnv(t *testing.T) {
	var out, errBuf bytes.Buffer
	err := ExecuteCommand(`printf "%s" "$TAIL_VAR"; printf err >&2`, t.TempDir(),
		[]string{"TAIL_VAR=from-env"}, &out, &errBuf)
	if err != nil {
		t.Fatalf("ExecuteCommand: %v", err)
	}
	if out.String() != "from-env" {
		t.Errorf("stdout = %q, want %q", out.String(), "from-env")
	}
	if errBuf.String() != "err" {
		t.Errorf("stderr = %q, want %q", errBuf.String(), "err")
	}
}

// TestTail_ExecuteCommandFailsToStartInAMissingDir pins that a command that cannot even be
// started (its working directory does not exist) is reported as a start failure, not as a
// non-zero exit — the two are different diagnoses for the operator reading the job log.
func TestTail_ExecuteCommandFailsToStartInAMissingDir(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	err := ExecuteCommand("true", missing, nil, nil, nil)
	if err == nil {
		t.Fatal("ExecuteCommand in a missing dir = nil, want an error")
	}
	if !strings.Contains(err.Error(), "error starting command") {
		t.Fatalf("error = %v, want it reported as a start failure", err)
	}
}

// TestTail_ExecuteCommandReportsNonZeroExit pins that a command that starts and then fails is
// reported as a non-zero exit.
func TestTail_ExecuteCommandReportsNonZeroExit(t *testing.T) {
	err := ExecuteCommand("exit 3", t.TempDir(), nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "non-zero exit code") {
		t.Fatalf("error = %v, want a non-zero exit code failure", err)
	}
}
