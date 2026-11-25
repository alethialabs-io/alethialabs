// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The runner half of #7290. A mid-apply cancel cancels the job's context; what reaches `tofu` must
// be the SIGINT it traps — finish the resource in flight, WRITE STATE, release the lock — and only
// after the grace window a SIGKILL. A tofu killed outright never pushes its state, and the resources
// it already created exist in no state file.
//
// These drive the real TofuCLI.Apply (NewTofuCLI's wiring, runStateWriting's process handling) over
// a stand-in `tofu` script found through the lookPath seam. The script records "state pushed" from its
// SIGINT trap, which is exactly the window the console's state route must also admit.

// interruptibleTofuScript is a stand-in `tofu`. On `apply` it installs `trap`, signals it is running, and
// spins until interrupted.
const interruptibleTofuScript = `#!/bin/sh
case "$1" in
apply)
  trap '__TRAP__' INT
  : > "$ALETHIA_TEST_READY"
  while :; do sleep 0.05; done
  ;;
*) exit 0 ;;
esac
`

// newFakeTofuCLI writes a fake tofu whose SIGINT trap is `trap`, routes NewTofuCLI to it, and returns
// the CLI plus the marker path the trap writes and the ready path the script touches.
func newFakeTofuCLI(t *testing.T, trap string) (cli *TofuCLI, marker, ready string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("graceful SIGINT cancellation is unsupported on Windows")
	}
	resetTofuSeams(t)
	dir := t.TempDir()
	bin := filepath.Join(dir, "tofu")
	script := []byte(strings.Replace(interruptibleTofuScript, "__TRAP__", trap, 1))
	if err := os.WriteFile(bin, script, 0o755); err != nil {
		t.Fatalf("write fake tofu: %v", err)
	}
	lookPath = func(string) (string, error) { return bin, nil }
	marker = filepath.Join(dir, "state-pushed")
	ready = filepath.Join(dir, "ready")
	t.Setenv("ALETHIA_TEST_STATE_MARKER", marker)
	t.Setenv("ALETHIA_TEST_READY", ready)
	t.Setenv("TF_PLUGIN_CACHE_DIR", filepath.Join(dir, "plugins"))

	cli, err := NewTofuCLI(context.Background(), "", dir, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}
	return cli, marker, ready
}

// startApply runs Apply in the background, waits until the fake tofu is running, and returns the
// cancel func and a channel carrying Apply's result.
func startApply(t *testing.T, cli *TofuCLI, ready string) (context.CancelFunc, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- cli.Apply(ctx, "plan.out") }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			return cancel, done
		}
		if time.Now().After(deadline) {
			t.Fatal("fake tofu never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A cancel during apply interrupts tofu and lets it push its state before it exits — well inside
// the grace window, i.e. not by the SIGKILL escalation.
func TestApply_CancelInterruptsTofuSoItPushesState(t *testing.T) {
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "30")
	cli, marker, ready := newFakeTofuCLI(t, `printf pushed > "$ALETHIA_TEST_STATE_MARKER"; exit 1`)
	cancel, done := startApply(t, cli, ready)

	start := time.Now()
	cancel()
	var err error
	select {
	case err = <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("Apply did not return after the cancel")
	}
	if err == nil {
		t.Fatal("a cancelled Apply must report an error")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled Apply should surface context.Canceled so the runner posts CANCELLED; got %v", err)
	}
	got, rerr := os.ReadFile(marker)
	if rerr != nil || string(got) != "pushed" {
		t.Fatalf("tofu was not interrupted gracefully: its SIGINT handler never pushed state (read %q, %v)", got, rerr)
	}
	if elapsed := time.Since(start); elapsed >= 30*time.Second {
		t.Fatalf("tofu exited only after %s — that is the SIGKILL escalation, not the interrupt", elapsed)
	}
}

// The window the #7290 orphan came back through on Linux CI: the cancel lands while tofu is still
// being started. terraform-exec checked ctx.Err() right after cmd.Start() and returned
// context.Canceled WITHOUT waiting, while the os/exec watcher had already sent the SIGINT — so
// Apply reported CANCELLED with tofu still running its shutdown, and its state push would then hit
// a released lock. The hook cancels at exactly that point; Apply must still return only after the
// tofu process has exited (ProcessState is set by Wait, and only by Wait).
func TestApply_CancelWhileTofuIsStartingStillWaitsForIt(t *testing.T) {
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "30")
	cli, _, _ := newFakeTofuCLI(t, `exit 1`)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	var started *exec.Cmd
	startedHook = func(c *exec.Cmd) { started = c; cancel() }

	err := cli.Apply(ctx, "plan.out")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled Apply should surface context.Canceled; got %v", err)
	}
	if started == nil {
		t.Fatal("tofu was never started")
	}
	if started.ProcessState == nil {
		t.Fatal("Apply returned while tofu was still running — its state push would hit a released lock")
	}
}

// A tofu that ignores the interrupt is still stopped, by the escalation after the grace window, so a
// wedged apply cannot hold the job forever.
func TestApply_CancelEscalatesToKillAfterTheGraceWindow(t *testing.T) {
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "1")
	cli, marker, ready := newFakeTofuCLI(t, ``) // trap '' INT: ignore the interrupt
	cancel, done := startApply(t, cli, ready)

	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a killed Apply must report an error")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Apply did not return after the grace window — the SIGKILL escalation never fired")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("an ignored interrupt must not have pushed state")
	}
}
