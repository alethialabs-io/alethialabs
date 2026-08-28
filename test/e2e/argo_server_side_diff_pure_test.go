// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure half of the server-side-diff probe — no cluster, so it runs on every PR.
//
// The rule: `argocd app diff` exits 1 for BOTH "I found a difference" and "I did not understand
// your flags", and this probe exists to answer a question that has already been answered wrong
// twice on #2717. So every outcome that is not a comparison must say COULD NOT ASK, and no branch
// may render a could-not-ask as a verdict in either direction.
package e2e

import (
	"errors"
	"strings"
	"testing"
)

// exitErr — the real *exec.ExitError fabricator — is shared with argo_diff_pure_test.go, which
// already verifies it produced the code it was asked for.

func TestArgoServerSideDiffNamesADifference(t *testing.T) {
	got := describeArgoServerSideDiff("addon-tempo",
		"===== apps/StatefulSet monitoring/addon-tempo =====\n> annotations: null\n", "",
		exitErr(t, argoDiffExitCodeMeansDiff))
	if !strings.Contains(got, "NAMES A DIFFERENCE") {
		t.Fatalf("exit 1 with output is a found diff, got %q", got)
	}
	if !strings.Contains(got, "annotations: null") {
		t.Fatalf("the diff body is the whole point and must be carried through: %q", got)
	}
	if strings.Contains(got, "COULD NOT ASK") {
		t.Fatalf("a found diff must not render as a failure to ask: %q", got)
	}
}

func TestArgoServerSideDiffFindsNothing(t *testing.T) {
	got := describeArgoServerSideDiff("addon-tempo", "", "", nil)
	if !strings.Contains(got, "finds NO difference") {
		t.Fatalf("exit 0 with no output must state the finding, got %q", got)
	}
	// "we ran it and it was clean" must never be silence, and must never look like a failure.
	if strings.Contains(got, "COULD NOT ASK") {
		t.Fatalf("a clean run must not render as a failure to ask: %q", got)
	}
	if !strings.Contains(got, "STRUCTURED-MERGE") {
		t.Fatalf("the clean result is only actionable next to what the controller ran: %q", got)
	}
}

func TestArgoServerSideDiffCannotMistakeAnUnknownFlagForADifference(t *testing.T) {
	// THE trap this probe is most likely to fall into: an older CLI rejects --server-side-diff and
	// exits 1, exactly like a found difference. Rendering that as "NAMES A DIFFERENCE" would ship a
	// fabricated field to an issue that has already been answered wrong twice.
	for _, raw := range []string{
		"Error: unknown flag: --server-side-diff",
		"unknown shorthand flag: 's' in -s",
		"flag provided but not defined: -server-side-diff",
		// Case must not matter: the CLI's wording is not a contract.
		"ERROR: Unknown Flag: --server-side-diff",
	} {
		got := describeArgoServerSideDiff("addon-tempo", "", raw, exitErr(t, argoDiffExitCodeMeansDiff))
		if !strings.Contains(got, "COULD NOT ASK") {
			t.Fatalf("an unusable flag must render as COULD NOT ASK, got %q for %q", got, raw)
		}
		for _, forbidden := range []string{"NAMES A DIFFERENCE", "finds NO difference"} {
			if strings.Contains(got, forbidden) {
				t.Fatalf("an unusable flag leaked the verdict %q for %q: %s", forbidden, raw, got)
			}
		}
	}
}

func TestArgoServerSideDiffCannotInventAVerdict(t *testing.T) {
	// Any other failure — exec not found, exec into a dead pod, a non-1 exit — is a failure to ask.
	for _, tc := range []struct {
		name   string
		stdout string
		stderr string
		err    error
	}{
		{"binary missing", "", "", errors.New(`exec: "kubectl": executable file not found in $PATH`)},
		// THE regression this separation exists for. kubectl's own exit 1 carries text, and on a
		// combined stream that text rendered as the field the controller is reacting to.
		{"pod gone", "", "Error from server (NotFound): pods \"x\" not found", exitErr(t, 1)},
		{"unreadable kubeconfig", "", "error: stat /nonexistent: no such file or directory", exitErr(t, argoDiffExitCodeMeansDiff)},
		{"other exit code", "", "boom", exitErr(t, 20)},
		// Exit 1 with NO stdout is not a diff: `argocd app diff` prints the diff it found there.
		{"exit 1 no output", "", "", exitErr(t, argoDiffExitCodeMeansDiff)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := describeArgoServerSideDiff("addon-tempo", tc.stdout, tc.stderr, tc.err)
			if !strings.Contains(got, "COULD NOT ASK") {
				t.Fatalf("want COULD NOT ASK, got %q", got)
			}
			for _, forbidden := range []string{"NAMES A DIFFERENCE", "finds NO difference"} {
				if strings.Contains(got, forbidden) {
					t.Fatalf("leaked the verdict %q: %s", forbidden, got)
				}
			}
		})
	}
}

func TestArgoServerSideDiffReportsAnUndocumentedShapeAsItself(t *testing.T) {
	// Exit 0 WITH output is neither documented outcome. It must be reported, not forced into one —
	// forcing it either way is how a probe manufactures a finding.
	got := describeArgoServerSideDiff("addon-tempo", "something unexpected", "", nil)
	if strings.Contains(got, "finds NO difference") || strings.Contains(got, "NAMES A DIFFERENCE") {
		t.Fatalf("an undocumented shape must not be forced into a verdict: %q", got)
	}
	if !strings.Contains(got, "something unexpected") {
		t.Fatalf("the unexpected output must be carried through: %q", got)
	}
}

func TestArgoServerSideDiffWithoutAClusterSaysSoRatherThanGuessing(t *testing.T) {
	got := argoServerSideDiff(t.Context(), "/nonexistent-kubeconfig",
		"statefulset.apps/argo-cd-argocd-application-controller", "addon-tempo")
	if !strings.Contains(got, "COULD NOT ASK") {
		t.Fatalf("want COULD NOT ASK without a cluster, got %q", got)
	}
	if strings.Contains(got, "finds NO difference") {
		t.Fatalf("an unreachable cluster must not read as a clean comparison: %q", got)
	}
}

func TestArgoServerSideDiffNeverReadsStderrAsTheDiff(t *testing.T) {
	// Stated as its own property rather than left implicit in the table above: whatever a failing
	// `kubectl exec` writes, only STDOUT can ever become "the field the controller is reacting to".
	// Varying the stderr text is the right axis here — the earlier version of this probe passed
	// every could-not-ask test that varied the EXIT CODE and still shipped the bug.
	for _, stderr := range []string{
		"Error from server (NotFound): pods \"x\" not found",
		"error: stat /nonexistent-kubeconfig: no such file or directory",
		"===== apps/StatefulSet monitoring/addon-tempo =====\n> annotations: null",
		"The connection to the server localhost:8080 was refused",
	} {
		got := describeArgoServerSideDiff("addon-tempo", "", stderr, exitErr(t, argoDiffExitCodeMeansDiff))
		if !strings.Contains(got, "COULD NOT ASK") {
			t.Fatalf("stderr-only output must render as COULD NOT ASK, got %q for %q", got, stderr)
		}
		if strings.Contains(got, "NAMES A DIFFERENCE") {
			t.Fatalf("stderr was read as a diff for %q: %s", stderr, got)
		}
	}
}
