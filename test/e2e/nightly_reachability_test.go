// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guard: a T2 scenario that the nightly workflow never passes an env var for is DEAD CODE that
// looks alive. The harness compiles, its unit tests pass, the board says the scenario shipped — and
// it never runs, because nothing ever sets its enable flag.
//
// This is not hypothetical. #1341 shipped the vcluster-placement harness with no
// ALETHIA_E2E_VCLUSTER anywhere in e2e-nightly.yml, and the day-2 access layer had the same gap;
// both sat silently unexecuted. That is the worst failure mode a test suite has, because coverage
// looks like it grew.
package e2e

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

var alethiaE2EVar = regexp.MustCompile(`ALETHIA_E2E_[A-Z0-9_]+`)

// nightlyExemptEnv are the ALETHIA_E2E_* knobs the nightly is NOT expected to pass, each with the
// reason it is exempt. Anything else the harness reads must be referenced by e2e-nightly.yml.
//
// The allowlist is the point: excluding a var is a deliberate, reviewed act with a stated reason,
// not something that happens by forgetting. Adding a scenario means either wiring it into the
// nightly or writing down here why it can never run there.
var nightlyExemptEnv = map[string]string{
	"ALETHIA_E2E_T1_REQUIRE":          "T1 is hermetic (kind) and runs from ci.yml, not the nightly",
	"ALETHIA_E2E_T1_RUNNER_LOG":       "T1 only",
	"ALETHIA_E2E_T1_WAIT":             "T1 only",
	"ALETHIA_E2E_T2_WAIT":             "per-provider default resolved from the provider row; overridden only for local debugging",
	"ALETHIA_E2E_ARGO_TIMEOUT":        "tuning knob with a sane default; overridden only for local debugging",
	"ALETHIA_E2E_B6_REQUIRE":          "the B6 promotion gate is its own build tag and its own workflow",
	"ALETHIA_E2E_A05_ENFORCE":         "A0.5 fidelity ramp: warn-only until the maintainer flips it, deliberately not wired yet",
	"ALETHIA_E2E_A05_REAL_SNAPSHOT":   "A0.5 real-snapshot mode, enabled by hand during fidelity work",
	"ALETHIA_E2E_HCLOUD_REGION":       "legacy alias for ALETHIA_E2E_REGION, kept for back-compat only",
	"ALETHIA_E2E_DAY2_ACCESS_TIMEOUT": "tuning knob for the day-2 layer; the layer's own enable var is wired",
	"ALETHIA_E2E_DAY2_OFFER_TIMEOUT":  "tuning knob bounding each day-2 plan; the layer's own enable var (ALETHIA_E2E_DAY2_OFFER) is wired",
	// Deliberately NOT wired, unlike every other keyless variable. The dwell must exceed the cloud
	// token's lifetime or the rotation assertion passes against a proxy that never rotates anything —
	// so its default (16m, past the 15m RDS-IAM TTL) IS the proof. Exposing it as a repo variable
	// would make weakening the strongest claim in the scenario a one-field edit that nothing reviews.
	// It stays a local-debugging override, and whatever dwell actually ran is recorded in the proof
	// bundle beside the verdict.
	"ALETHIA_E2E_KEYLESS_DB_DWELL": "the rotation dwell must exceed the cloud token TTL to prove anything, so its default is the proof — a local-debugging override, never a repo variable",
}

// TestScenarioEnablesReachTheNightly fails when the harness reads an ALETHIA_E2E_* variable that
// e2e-nightly.yml never sets and that is not explicitly exempted above.
//
// Being REFERENCED is all this asserts — every scenario is wired as `${{ vars.X }}`, so an unset
// repo variable still means a clean skip. The guard separates "a maintainer chose not to enable
// this" from "no maintainer CAN enable this", which is the bug it exists to catch.
func TestScenarioEnablesReachTheNightly(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)

	wf, err := os.ReadFile(filepath.Join(dir, "..", "..", ".github", "workflows", "e2e-nightly.yml"))
	if err != nil {
		t.Fatalf("read e2e-nightly.yml: %v", err)
	}
	inWorkflow := map[string]bool{}
	for _, v := range alethiaE2EVar.FindAllString(string(wf), -1) {
		inWorkflow[v] = true
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read harness dir: %v", err)
	}
	used := map[string]string{} // var -> the file that reads it
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") {
			continue
		}
		// This guard's own allowlist mentions every exempt var; scanning it would be circular.
		if name == filepath.Base(thisFile) {
			continue
		}
		src, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, v := range alethiaE2EVar.FindAllString(string(src), -1) {
			if _, seen := used[v]; !seen {
				used[v] = name
			}
		}
	}

	var unreachable []string
	for v, file := range used {
		if inWorkflow[v] {
			continue
		}
		if _, exempt := nightlyExemptEnv[v]; exempt {
			continue
		}
		unreachable = append(unreachable, v+" (read by "+file+")")
	}
	sort.Strings(unreachable)
	if len(unreachable) > 0 {
		t.Fatalf("these ALETHIA_E2E_* variables are read by the T2 harness but NEVER set by "+
			".github/workflows/e2e-nightly.yml, so the code that reads them can never run in the nightly:\n  %s\n\n"+
			"Either add them to the T2 step's env block (as `${{ vars.X }}`, which keeps them off until a "+
			"maintainer opts in) or add them to nightlyExemptEnv with the reason they can never run there.",
			strings.Join(unreachable, "\n  "))
	}

	// Guard the guard: a stale exemption means a var was renamed or deleted and the allowlist kept a
	// dead entry, which would quietly re-open the hole for the NEXT var with that name.
	for v := range nightlyExemptEnv {
		if _, stillUsed := used[v]; !stillUsed {
			t.Errorf("nightlyExemptEnv has a stale entry %q — no harness file reads it any more; remove it", v)
		}
	}
}
