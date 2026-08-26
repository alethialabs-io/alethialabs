// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure halves of the `argocd app diff` dump — no cluster, so they run on every PR.
//
// The reason they exist: `argocd app diff` exits 1 WHEN IT FINDS A DIFFERENCE, the same convention
// `diff(1)` uses. That is a verdict, not a failure, and it is the only outcome the dump was written
// for — so mistaking it for an error would make the whole thing report nothing on precisely the
// runs it is meant to explain. I have shipped that exact bug before, in
// scripts/addons/check-render-determinism.sh, where `diff`'s exit 1 under `pipefail` aborted the
// sweep before its own summary.

package e2e

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

// exitErr fabricates the *exec.ExitError a real kubectl/argocd invocation would return, by running
// a command that exits with the given code.
//
// It verifies the code it actually got: the first version built the argument with
// `string(rune('0'+code))`, which is fine for one digit and garbage for 126 — and a helper that
// silently fabricates the WRONG error would make every test below assert against a case that never
// occurs.
func exitErr(t *testing.T, code int) error {
	t.Helper()
	err := exec.Command("sh", "-c", fmt.Sprintf("exit %d", code)).Run()
	if err == nil {
		t.Fatalf("expected a non-zero exit for code %d", code)
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != code {
		t.Fatalf("could not fabricate exit code %d, got %v", code, err)
	}
	return err
}

func TestInterpretArgoDiff(t *testing.T) {
	t.Parallel()

	t.Run("exit 1 with output IS the success case — a diff was found", func(t *testing.T) {
		t.Parallel()
		diff := "===== apps/StatefulSet argocd/addon-loki ======\n-  replicas: 1\n+  replicas: 2"
		got := interpretArgoDiff("addon-loki", diff, exitErr(t, 1))
		if !strings.Contains(got, "replicas") {
			t.Fatalf("the diff itself was dropped: %q", got)
		}
		// It must NOT be reported as a failure — that is the whole bug being defended against.
		if strings.Contains(got, "could NOT be read") {
			t.Fatalf("a found difference was reported as a failure: %q", got)
		}
		if strings.Contains(got, "reports NO difference") {
			t.Fatalf("a found difference was reported as no difference: %q", got)
		}
	})

	t.Run("exit 0 with no output says so explicitly", func(t *testing.T) {
		t.Parallel()
		// ArgoCD sees no difference while the Application reports OutOfSync. Real and specific,
		// and it must not render as an empty section that reads like nothing ran.
		got := interpretArgoDiff("addon-tempo", "", nil)
		if !strings.Contains(got, "reports NO difference") {
			t.Fatalf("silent on the no-difference case: %q", got)
		}
		if strings.TrimSpace(got) == "" {
			t.Fatal("rendered nothing at all")
		}
	})

	t.Run("a real failure is distinguishable from no difference", func(t *testing.T) {
		t.Parallel()
		got := interpretArgoDiff("addon-kyverno", "error: unable to upgrade connection", exitErr(t, 126))
		if !strings.Contains(got, "could NOT be read") {
			t.Fatalf("a failure did not say so: %q", got)
		}
		if strings.Contains(got, "reports NO difference") {
			t.Fatalf("a failure rendered as a no-difference finding: %q", got)
		}
		// The reason has to survive: "could not read it" without the cause is barely better
		// than silence.
		if !strings.Contains(got, "unable to upgrade connection") {
			t.Fatalf("the failure output was dropped: %q", got)
		}
	})

	t.Run("a failure with NO output still names the failure", func(t *testing.T) {
		t.Parallel()
		got := interpretArgoDiff("addon-harbor", "", exitErr(t, 127))
		if !strings.Contains(got, "could NOT be read") || !strings.Contains(got, "(no output)") {
			t.Fatalf("empty failure rendered unhelpfully: %q", got)
		}
	})

	t.Run("exit 1 with NO output is a failure, not a diff", func(t *testing.T) {
		t.Parallel()
		// The command claims a difference and printed nothing. That is not usable evidence, and
		// treating it as a diff would print an empty section under a heading that promises one.
		got := interpretArgoDiff("addon-argo-rollouts", "", exitErr(t, 1))
		if !strings.Contains(got, "could NOT be read") {
			t.Fatalf("exit 1 with no output was treated as a diff: %q", got)
		}
	})

	t.Run("every outcome names the application", func(t *testing.T) {
		t.Parallel()
		for _, got := range []string{
			interpretArgoDiff("addon-x", "some diff", exitErr(t, 1)),
			interpretArgoDiff("addon-x", "", nil),
			interpretArgoDiff("addon-x", "boom", exitErr(t, 2)),
		} {
			if !strings.Contains(got, "addon-x") {
				t.Fatalf("section does not name its app: %q", got)
			}
		}
	})
}

func TestTruncateDiff(t *testing.T) {
	t.Parallel()

	t.Run("short input is untouched", func(t *testing.T) {
		t.Parallel()
		if got := truncateDiff("small"); got != "small" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("long input is capped AND says it was capped", func(t *testing.T) {
		t.Parallel()
		// A silent truncation reads as "that was the whole diff", which is how someone concludes a
		// field is absent when it was merely cut off.
		got := truncateDiff(strings.Repeat("x", maxArgoDiffBytes+500))
		if len(got) > maxArgoDiffBytes+64 {
			t.Fatalf("not capped: %d bytes", len(got))
		}
		if !strings.Contains(got, "truncated") {
			t.Fatal("truncated silently")
		}
	})
}

func TestOutOfSyncLosers(t *testing.T) {
	t.Parallel()

	observed := map[string]argoAppState{
		"addon-loki":         {Health: "Progressing", Sync: "OutOfSync"},
		"addon-tempo":        {Health: "Healthy", Sync: "OutOfSync"},
		"addon-falco":        {Health: "Progressing", Sync: "Synced"},
		"addon-external-dns": {Health: "Degraded", Sync: "Synced"},
		"addon-keda":         {Health: "Healthy", Sync: "Synced"},
	}

	t.Run("selects only the OutOfSync losers, sorted", func(t *testing.T) {
		t.Parallel()
		got := outOfSyncLosers(observed, []string{"addon-tempo", "addon-falco", "addon-loki", "addon-external-dns"})
		want := []string{"addon-loki", "addon-tempo"}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})

	t.Run("a loser ArgoCD never reported is dropped, not diffed blindly", func(t *testing.T) {
		t.Parallel()
		if got := outOfSyncLosers(observed, []string{"addon-never-seen"}); len(got) != 0 {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("no OutOfSync loser yields none — the caller says so rather than staying silent", func(t *testing.T) {
		t.Parallel()
		if got := outOfSyncLosers(observed, []string{"addon-falco", "addon-external-dns"}); len(got) != 0 {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("nil inputs do not panic", func(t *testing.T) {
		t.Parallel()
		if got := outOfSyncLosers(nil, []string{"addon-loki"}); len(got) != 0 {
			t.Fatalf("got %v", got)
		}
		if got := outOfSyncLosers(observed, nil); len(got) != 0 {
			t.Fatalf("got %v", got)
		}
	})
}

func TestDumpArgoAppDiffsNoOutOfSyncLoser(t *testing.T) {
	t.Parallel()
	// The early return, and the only branch of dumpArgoAppDiffs that runs no kubectl at all — so it
	// is testable here, and it is the branch most worth pinning: when every loser is Degraded or
	// Progressing while SYNCED, there is genuinely no diff to fetch, and saying so is different from
	// emitting nothing. An empty section reads like the dump never ran.
	observed := map[string]argoAppState{
		"addon-falco":        {Health: "Progressing", Sync: "Synced"},
		"addon-external-dns": {Health: "Degraded", Sync: "Synced"},
	}
	got := dumpArgoAppDiffs(context.Background(), "/nonexistent-kubeconfig",
		observed, []string{"addon-falco", "addon-external-dns"})

	if !strings.Contains(got, "no loser is OutOfSync") {
		t.Fatalf("did not explain why there is no diff: %q", got)
	}
	if strings.TrimSpace(got) == "" {
		t.Fatal("rendered nothing, which reads as 'the dump never ran'")
	}
	// It must not have tried to exec — a bogus kubeconfig would surface as a "could NOT be read"
	// section if it had.
	if strings.Contains(got, "could NOT be read") {
		t.Fatalf("attempted a diff for a Synced loser: %q", got)
	}
}

func TestDumpArgoAppDiffsSkipsLosersArgoNeverReported(t *testing.T) {
	t.Parallel()
	// A loser absent from `observed` has no sync status to judge, so it must not be diffed blindly.
	got := dumpArgoAppDiffs(context.Background(), "/nonexistent-kubeconfig",
		map[string]argoAppState{}, []string{"addon-never-seen"})
	if !strings.Contains(got, "no loser is OutOfSync") {
		t.Fatalf("unknown loser was not skipped: %q", got)
	}
}
