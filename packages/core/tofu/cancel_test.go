// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// stubbornTofuScript answers the version probe and then blocks while IGNORING SIGINT — the
// shape of a real `tofu` that has trapped the graceful interrupt and is finishing the
// in-flight resource (or has wedged on a cloud API call that never returns).
const stubbornTofuScript = `#!/bin/sh
if [ "$1" = "version" ]; then
  echo '{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}'
  exit 0
fi
trap '' INT
sleep 60
`

// newStubbornTofuCLI installs stubbornTofuScript on the lookPath seam and returns a TofuCLI
// over a scratch workdir.
func newStubbornTofuCLI(t *testing.T) *TofuCLI {
	t.Helper()
	resetTofuSeams(t)

	binDir := t.TempDir()
	binPath := filepath.Join(binDir, "tofu")
	if err := os.WriteFile(binPath, []byte(stubbornTofuScript), 0o755); err != nil {
		t.Fatalf("write stubborn tofu: %v", err)
	}
	lookPath = func(string) (string, error) { return binPath, nil }
	httpGet = func(context.Context, string) ([]byte, error) {
		t.Fatal("the stubborn tofu is on PATH; no download should be attempted")
		return nil, nil
	}

	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "main.tf"), []byte("# empty\n"), 0o600); err != nil {
		t.Fatalf("write module: %v", err)
	}
	tf, err := NewTofuCLI(context.Background(), "1.9.0", workDir, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}
	return tf
}

// TestCancel_EscalatesToSIGKILLAfterTheGraceWindow covers the cancellation wiring
// NewTofuCLI installs (SetWaitDelay(cancelGracePeriod())): a job cancelled mid-command
// SIGINTs the `tofu` child, and when the child does not stop on its own the stdlib must
// escalate to SIGKILL once the grace window elapses. Without the escalation the wrapper
// blocks for as long as the child chooses to run, holding the job slot and the state lock.
//
// The grace window is set to one second so the escalation is observable; a real deploy uses
// DefaultCancelGracePeriod (120s) so a graceful stop has time to finish its resource.
func TestCancel_EscalatesToSIGKILLAfterTheGraceWindow(t *testing.T) {
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "1")
	tf := newStubbornTofuCLI(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tf.Init(ctx, nil, false) }()

	// Let the child reach its blocking section before cancelling.
	time.Sleep(300 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Init reported success for a cancelled command")
		}
	// The child sleeps for 60s, so anything under that proves the escalation fired.
	case <-time.After(15 * time.Second):
		t.Fatal("a cancelled tofu was never terminated: the SIGINT→SIGKILL escalation did not fire")
	}
}
