// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
)

func TestRunUpdateRejectsDevelopmentBuild(t *testing.T) {
	_, err := runUpdate(context.Background(), &bytes.Buffer{}, "dev", "https://example.invalid")
	if err == nil || !strings.Contains(err.Error(), "development build") {
		t.Fatalf("expected development-build error, got %v", err)
	}
	if e := clierr.From(err); e.Exit != clierr.ExitConflict || !strings.Contains(e.Hint, installDocsURL) {
		t.Fatalf("exit %d, hint %q: want a failed precondition that says where a release comes from", e.Exit, e.Hint)
	}
}

func TestRunUpdateReportsCurrentVersionWithoutInstalling(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/releases/cli" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"version":"1.2.3","github_release_url":"https://example.com/release","min_supported_version":null}`))
	}))
	defer server.Close()

	var progress bytes.Buffer
	outcome, err := runUpdate(context.Background(), &progress, "1.2.3", server.URL)
	if err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	if outcome.Updated || outcome.UpdateAvailable || outcome.From != "1.2.3" || progress.Len() != 0 {
		t.Fatalf("outcome = %+v, progress = %q", outcome, progress.String())
	}
	var said bytes.Buffer
	renderUpdate(&said, outcome)
	if !strings.Contains(said.String(), "already up to date") {
		t.Fatalf("unexpected output: %q", said.String())
	}
}

func TestRunUpdateRejectsInvalidReleasePayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"not-a-version"}`))
	}))
	defer server.Close()
	_, err := runUpdate(context.Background(), &bytes.Buffer{}, "1.0.0", server.URL)
	if err == nil || !strings.Contains(err.Error(), "invalid CLI version") {
		t.Fatalf("expected invalid release error, got %v", err)
	}
	if clierr.From(err).Hint == "" {
		t.Fatal("the refusal carries no next step")
	}
}

func TestRunUpdateReportsReleaseLookupFailure(t *testing.T) {
	_, err := runUpdate(context.Background(), &bytes.Buffer{}, "1.0.0", "https://example.invalid")
	if err == nil || !strings.Contains(err.Error(), "check the latest alethia release") {
		t.Fatalf("expected release lookup error, got %v", err)
	}
	if e := clierr.From(err); e.Exit != clierr.ExitUnavailable {
		t.Fatalf("exit = %d, want %d (the control plane could not be asked)", e.Exit, clierr.ExitUnavailable)
	}
}

// An install channel this command does not change is a failed precondition whose message is the
// command to run instead.
func TestUpdateErrorClassifiesAManualChannel(t *testing.T) {
	manual := &update.ManualUpdateError{Instruction: "run `sudo dpkg -i alethia.deb`"}
	e := clierr.From(updateError(manual))
	if e.Exit != clierr.ExitConflict || e.Message != manual.Instruction || e.Hint == "" {
		t.Fatalf("%+v", e)
	}
	if updateError(nil) != nil {
		t.Fatal("no error must stay no error")
	}
}

func TestUpdateCommandIsRegistered(t *testing.T) {
	command, _, err := rootCmd.Find([]string{"update"})
	if err != nil || command != updateCmd {
		t.Fatalf("update command not registered: command=%v err=%v", command, err)
	}
	if updateCmd.Args == nil || updateCmd.Annotations[skipUpdateNoticeAnnotation] != "true" {
		t.Fatal("update command must reject arguments and suppress the stale-process notice")
	}
}
