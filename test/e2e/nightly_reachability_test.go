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
//
// This file carries TWO guards, because the first one could not catch #1047. It scans the variables
// that harness files READ — and there, the file was never written at all:
// scripts/e2e/registry-e2e.sh invoked `-run TestT2XacctRegistry`, a function that existed in no
// file, so it recorded BLOCKED forever while the parity board reported the vehicle as shipped. A
// script that names a test nobody wrote is indistinguishable, from the outside, from a lane waiting
// on a maintainer. TestScriptRunTargetsResolveToRealTests closes that.
package e2e

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

var alethiaE2EVar = regexp.MustCompile(`ALETHIA_E2E_[A-Z0-9_]+`)

// stripLineComments removes `#`-to-end-of-line comments from YAML/shell source, so a variable merely
// DISCUSSED in prose cannot satisfy the reachability guard — only one that is actually wired.
//
// It is deliberately naive about `#` inside quotes: over-stripping can only ever make the guard
// STRICTER (a real setter would have to be restated outside a string), and strictness is the safe
// direction for a guard whose whole job is to refuse a claim. Under-stripping is the failure that
// matters, and it is the one this closes.
func stripLineComments(src string) string {
	lines := strings.Split(src, "\n")
	for i, ln := range lines {
		if idx := strings.Index(ln, "#"); idx >= 0 {
			lines[i] = ln[:idx]
		}
	}
	return strings.Join(lines, "\n")
}

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

	// The SETTERS. A var counts as reachable if the workflow sets it, or if the dimension fidelity
	// table does — since #2356 the workflow delegates the per-dimension env to
	// scripts/e2e/resolve-dimension.sh (`--fidelity`) and appends its output to $GITHUB_ENV, so the
	// table is a genuine setter and scanning only the workflow would report a wired var as dead.
	setters := []string{
		filepath.Join(dir, "..", "..", ".github", "workflows", "e2e-nightly.yml"),
		filepath.Join(dir, "..", "..", "scripts", "e2e", "resolve-dimension.sh"),
	}
	inWorkflow := map[string]bool{}
	for _, p := range setters {
		src, rerr := os.ReadFile(p)
		if rerr != nil {
			t.Fatalf("read %s: %v", filepath.Base(p), rerr)
		}
		// COMMENTS DO NOT COUNT. This used to match the raw file, so a var merely NAMED in a comment
		// satisfied the guard — and #2356 moved the real `ALETHIA_E2E_SOAK` wiring out of the
		// workflow into the fidelity table while leaving a comment behind explaining the move. The
		// guard stayed green for the wrong reason: prose, not wiring. A guard a comment can satisfy
		// is a guard that has stopped asking its question.
		//
		// Scope, stated honestly: this asks "is the var wired ANYWHERE a setter could set it", not
		// "does every dimension emit the right value". The second question belongs to
		// `resolve-dimension.sh --self-test`, which asserts the table's per-dimension output directly
		// (delete the floor's `ALETHIA_E2E_SOAK=off` and five of its checks fail). Two guards, two
		// questions — this one would still pass on a var named only in that script's own test
		// assertions, and that is acceptable precisely because the other guard covers the emit.
		for _, v := range alethiaE2EVar.FindAllString(stripLineComments(string(src)), -1) {
			inWorkflow[v] = true
		}
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

// goTestRunTarget matches a `go test … -run <target>` invocation, quoted or bare. Both forms occur in
// scripts/e2e/*.sh, and both have to be seen: registry-e2e.sh quoted its phantom target while
// provisioning-e2e.sh writes its real one bare.
var goTestRunTarget = regexp.MustCompile(`-run\s+"([^"]+)"|-run\s+([^\s"'\\]+)`)

// goTestFuncDecl matches a Go test function declaration in any *_test.go file, under ANY build tag.
// Tags are deliberately ignored: the question this guard asks is whether the function EXISTS, and a
// tag-gated harness is exactly the shape every one of these scripts invokes.
var goTestFuncDecl = regexp.MustCompile(`(?m)^func (Test[A-Za-z0-9_]*)\s*\(`)

// scriptRunTargetSkipDirs are trees that hold no first-party Go and are expensive to walk.
var scriptRunTargetSkipDirs = map[string]bool{
	".git": true, "node_modules": true, ".next": true, ".turbo": true,
	"dist": true, "build": true, "vendor": true, "coverage": true,
}

// TestScriptRunTargetsResolveToRealTests fails when a scripts/e2e/*.sh runner names a Go test
// function that does not exist anywhere in the repository.
//
// TestScenarioEnablesReachTheNightly (above) is structurally incapable of catching this. It scans the
// ALETHIA_E2E_* variables read by harness files that EXIST; when the harness was never written there
// is no file to scan, so the hole is invisible to it. That is precisely what happened in #1047:
// registry-e2e.sh ran `-run "TestT2XacctRegistry"` for months, `go test` matched no test, the script
// classified the empty run as BLOCKED — the same verdict a real quota block produces — and
// docs/testing/xacct-registry-parity.md went on naming the harness as the vehicle.
//
// The check is deliberately about EXISTENCE, not about wiring. A test that exists but is gated off is
// a maintainer's choice; a test that does not exist is a script that can never pass.
func TestScriptRunTargetsResolveToRealTests(t *testing.T) {
	root := repoRootFromThisFile(t)

	scripts, err := filepath.Glob(filepath.Join(root, "scripts", "e2e", "*.sh"))
	if err != nil {
		t.Fatalf("glob scripts/e2e: %v", err)
	}
	if len(scripts) == 0 {
		t.Fatal("no scripts/e2e/*.sh found — this guard would pass vacuously, which is the failure mode it exists to prevent")
	}

	// target -> the script(s) that name it.
	named := map[string][]string{}
	for _, path := range scripts {
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			t.Fatalf("read %s: %v", path, rerr)
		}
		for _, m := range goTestRunTarget.FindAllStringSubmatch(string(src), -1) {
			raw := m[1]
			if raw == "" {
				raw = m[2]
			}
			for _, name := range runTargetNames(raw) {
				base := filepath.Base(path)
				if !contains(named[name], base) {
					named[name] = append(named[name], base)
				}
			}
		}
	}
	if len(named) == 0 {
		t.Fatal("no `-run` targets found in scripts/e2e/*.sh — the matcher stopped matching, so this guard is silently inert")
	}

	declared := map[string]bool{}
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable tree is not this guard's business
		}
		if d.IsDir() {
			if scriptRunTargetSkipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			return nil
		}
		for _, m := range goTestFuncDecl.FindAllStringSubmatch(string(src), -1) {
			declared[m[1]] = true
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk repository: %v", walkErr)
	}
	if len(declared) == 0 {
		t.Fatal("no Go test functions found in the repository — the declaration matcher is broken, so every target would look unresolved")
	}

	var unresolved []string
	for name, from := range named {
		if declared[name] {
			continue
		}
		sort.Strings(from)
		unresolved = append(unresolved, name+" (named by "+strings.Join(from, ", ")+")")
	}
	sort.Strings(unresolved)
	if len(unresolved) > 0 {
		t.Fatalf("these `-run` targets are invoked by scripts/e2e/*.sh but exist in NO Go test file, so those scripts can never run anything:\n  %s\n\n"+
			"Either write the test, or point the script at the test that actually drives the scenario "+
			"(the layered T2 scenarios all run inside TestT2RealCloudProvisioning). A script naming a test "+
			"nobody wrote records BLOCKED forever, which reads exactly like a lane waiting on a maintainer.",
			strings.Join(unresolved, "\n  "))
	}
}

// runTargetNames normalizes a `-run` argument into the concrete test names it addresses.
//
// `-run` takes a regular expression: alternations select several tests, `/` separates subtest levels,
// and `^`/`$` anchor. Only the top-level name matters here, and anything carrying shell interpolation
// or genuine regex metacharacters is skipped rather than guessed at — a false accusation from this
// guard would be worse than a miss, because the next person would learn to ignore it.
func runTargetNames(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, "|") {
		name := strings.TrimSpace(part)
		name = strings.TrimPrefix(name, "^")
		name, _, _ = strings.Cut(name, "/") // subtest path — only the top-level func exists in source
		name = strings.TrimSuffix(name, "$")
		if name == "" || !strings.HasPrefix(name, "Test") {
			continue
		}
		// A shell variable or any regex metacharacter left over: not a literal test name.
		if strings.ContainsAny(name, `$*+?.()[]{}\`) {
			continue
		}
		out = append(out, name)
	}
	return out
}

// contains reports whether s is already in list.
func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
