// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestHetznerLBCaptureHandoffAgrees pins the two ends of a hand-off that is otherwise two
// independent string literals in two languages.
//
// The e2e process writes ${RUNNER_TEMP}/<hetznerLBCaptureBasename>; the sweeper that reads it runs
// in a DIFFERENT process (the workflow's always() teardown step) and is pointed at
// ALETHIA_E2E_HCLOUD_LB_IDS by the workflow. Nothing connects them but the string. Rename or move
// either — or drop the `export` from one of the two teardown steps — and the behaviour silently
// reverts: the sweep falls back to the project-wide question and the leg starts reding again on any
// concurrent run's load balancer, with no signal that the fix stopped working.
//
// UNTAGGED so it runs on every PR. The writer is behind `e2e_t2`, and a guard that only fires on a
// paid nightly reports the breakage after it has already cost a run.
func TestHetznerLBCaptureHandoffAgrees(t *testing.T) {
	t.Parallel()

	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not resolve this file's path — the scan cannot be anchored")
	}
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	wf := filepath.Join(root, ".github", "workflows", "e2e-nightly.yml")
	raw, err := os.ReadFile(wf)
	if err != nil {
		t.Fatalf("could not read %s (%v) — this test cannot check anything", wf, err)
	}

	// Guards the guard, FIRST: a basename that became empty would make the pattern below match a
	// bare `${RUNNER_TEMP}/"` and pass while asserting nothing.
	if !strings.Contains(hetznerLBCaptureBasename, ".") {
		t.Fatalf("hetznerLBCaptureBasename is %q — not a filename, so the scan proves nothing", hetznerLBCaptureBasename)
	}

	want := `export ALETHIA_E2E_HCLOUD_LB_IDS="${RUNNER_TEMP}/` + hetznerLBCaptureBasename + `"`
	// TWO, not "at least one". There are two teardown steps, and the capture is invisible to
	// whichever one lacks the export — a partial hand-off reads as a working fix on one path and a
	// silent revert on the other.
	if n := strings.Count(string(raw), want); n != 2 {
		t.Errorf("e2e-nightly.yml points ALETHIA_E2E_HCLOUD_LB_IDS at\n  %s\nin %d place(s), want 2.\n"+
			"captureHetznerLoadBalancers writes ${RUNNER_TEMP}/%s and the sweeper reads whatever that "+
			"variable names. If they disagree the capture is written and never read, the sweep falls back "+
			"to the project-wide question, and the leg reds on a concurrent run's load balancer with "+
			"nothing saying why (#3481).", want, n, hetznerLBCaptureBasename)
	}
}
