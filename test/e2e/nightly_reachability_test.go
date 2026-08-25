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

// TestScenarioApplyToSnapshotIsCalled is the third guard in this file, and it closes the gap the
// first two structurally cannot see.
//
// The existing guards ask "is the enable VARIABLE wired?" and "does the script name a REAL test?".
// #1773 satisfied both and still could not pass: ALETHIA_E2E_ACM_CERT was wired in e2e-nightly.yml,
// acmCertConfig.decide() turned the layer on, the provision test logged "ACM certificate ENABLED",
// and runT2AcmCert then asserted a certificate that nothing had ever asked the template to build.
// acmCertConfig.applyToSnapshot existed, was unit-tested, carried a comment saying "this assignment
// is what the floor path uses" — and was called from no production path at all.
//
// Run 32838291742 is the record: the plan carried no aws_acm_certificate, `route53_zone_id = ""`,
// and the verdict read `no aws_acm_certificate_validation in state`. A scenario that ASSERTS without
// CONFIGURING cannot go green, and no amount of retrying moves it.
//
// So: every scenario type that DEFINES an applyToSnapshot must have it CALLED from the one function
// that assembles the deploy snapshot. The check is a source grep for the same reason the guards
// above are — it has to hold about the code as written, not about a code path a test happened to
// take.
func TestScenarioApplyToSnapshotIsCalled(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	dir := filepath.Dir(thisFile)
	self := filepath.Base(thisFile)

	// Receiver may be a POINTER and may be named anything. The first version matched only
	// `func (c X) applyToSnapshot(` — a single-letter VALUE receiver. `func (cfg X)` and
	// `func (c *X)` are both idiomatic Go no reviewer would flag, and either would have dropped the
	// scenario out of `defined` entirely, so the guard would report green on a completely unwired
	// scenario. Which is #1773, the thing it exists to catch.
	definer := scenarioDefinerRe
	// The assembler's DECLARATION, anchored at line start so a mention in prose or a string cannot
	// nominate a file as the assembler.
	assemblerDecl := scenarioAssemblerRe
	caller := scenarioCallerRe

	defined := map[string]string{}
	called := map[string]bool{}
	sig := ""
	sigFile := ""

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		base := filepath.Base(path)
		// SKIP THIS FILE. The first version did not, and it self-satisfied: the literal
		// `"func t2DeploySnapshot("` appears in this very function, so the guard nominated ITSELF as
		// the assembler, then matched its own comment `repos.applyToSnapshot(full)` and set
		// called["repos"] permanently. t2ArgoRepos was exempt forever and the len(called)==0
		// non-vacuity fatal was unreachable — the guard failed in the same way it was built to catch.
		if base == self {
			return nil
		}
		src, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		// Comments are stripped before any match: a call written in prose is not a call.
		text := stripGoComments(string(src))

		for _, m := range definer.FindAllStringSubmatch(text, -1) {
			defined[m[1]] = base
		}
		if m := assemblerDecl.FindStringSubmatch(text); m != nil {
			if sig != "" && sigFile != base {
				// Two files declaring it is not a thing to resolve by last-write-wins; that is how a
				// stray file could silently blank `sig` and produce five wrong diagnoses at once.
				t.Fatalf("t2DeploySnapshot is declared in both %s and %s — this guard cannot tell which assembles the snapshot", sigFile, base)
			}
			sig, sigFile = m[1], base
			for _, c := range caller.FindAllStringSubmatch(text, -1) {
				called[c[1]] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}

	if len(defined) == 0 {
		t.Fatal("found no applyToSnapshot definitions at all — this guard is scanning the wrong tree " +
			"and would pass over any number of unwired scenarios")
	}
	if sig == "" {
		t.Fatal("found no t2DeploySnapshot declaration — either it was renamed or this guard stopped " +
			"finding it; both make every result below meaningless, so this fails rather than passes")
	}
	if len(called) == 0 {
		t.Fatal("found no applyToSnapshot CALLS in t2DeploySnapshot — either every scenario is unwired " +
			"or the scan is broken; both make this guard vacuous, so it fails rather than passes")
	}

	// Resolve each scenario TYPE to the variable the assembler receives it as, by reading
	// t2DeploySnapshot's own parameter list. Matching type names against variable names by string
	// similarity does not work — `t2ArgoRepos` arrives as `repos`, `secretsXacctConfig` as `xacct` —
	// and a guard that guesses wrong either cries wolf or gets loosened until it catches nothing.
	//
	// `(?:,|$)` and not `(?:,|\))`: the captured signature is the parameter list WITHOUT its closing
	// paren, so a `\)` branch is dead and only a trailing comma could ever terminate a parameter.
	// The LAST parameter was therefore unresolvable — and the end of the signature is exactly where
	// the next scenario gets appended, as acmCert was.
	paramOf := map[string]string{}
	for _, m := range scenarioParamRe.FindAllStringSubmatch(sig, -1) {
		paramOf[m[2]] = m[1]
	}

	for typeName, file := range defined {
		v, isParam := paramOf[typeName]
		if !isParam {
			t.Errorf("%s defines applyToSnapshot (%s) but is not even a parameter of t2DeploySnapshot — "+
				"the scenario cannot reach a real deploy snapshot at all. That is #1773: "+
				"ALETHIA_E2E_ACM_CERT was wired, decide() said yes, the run logged ENABLED, and the "+
				"plan carried no certificate because acmCertConfig was never passed in.", typeName, file)
			continue
		}
		if !called[v] {
			t.Errorf("%s (%s) is passed to t2DeploySnapshot as %q but %s.applyToSnapshot is never "+
				"called there — the scenario can turn ON, log that it is enabled, and then assert "+
				"against a snapshot it never configured. Call it AFTER MaxConfigSnapshot.",
				typeName, file, v, v)
		}
	}
}

// stripGoComments removes // and /* */ comments so a call or a declaration written in PROSE cannot
// satisfy this file's guards. Naive about both inside string literals, which can only make the
// guards stricter — the safe direction for a check whose job is to refuse a claim.
// The four patterns the scenario guard matches with, at package scope so the guard and the tests
// below share ONE definition. They were locals, which meant every property they are relied on for —
// a pointer receiver, a multi-character receiver name, an anchored declaration, a LAST parameter
// with no trailing comma — could only be exercised by running the whole WalkDir against the real
// tree. Three of the four were wrong at some point and nothing failed.
var (
	// Receiver may be a POINTER and may be named anything.
	scenarioDefinerRe = regexp.MustCompile(`func \(\s*[A-Za-z_][A-Za-z0-9_]*\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\) applyToSnapshot\(`)
	// The assembler's DECLARATION, anchored at line start so prose cannot nominate a file.
	scenarioAssemblerRe = regexp.MustCompile(`(?m)^func t2DeploySnapshot\(([\s\S]*?)\)\s*\(`)
	scenarioCallerRe    = regexp.MustCompile(`\b([A-Za-z_][A-Za-z0-9_]*)\.applyToSnapshot\(`)
	// `(?:,|$)` and not `(?:,|\))`: sig is the parameter list WITHOUT its closing paren, so a `\)`
	// branch is dead and the LAST parameter — where the next scenario gets appended — never resolved.
	scenarioParamRe = regexp.MustCompile(`([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)`)
)

func stripGoComments(src string) string {
	var out strings.Builder
	out.Grow(len(src))
	for i := 0; i < len(src); i++ {
		switch c := src[i]; {
		case c == '"' || c == '`':
			// Copy the whole literal verbatim. A raw string cannot contain an escape, and an
			// interpreted one cannot span a line, so the two are terminated differently.
			quote := c
			out.WriteByte(c)
			for i++; i < len(src); i++ {
				if quote == '"' && src[i] == '\\' && i+1 < len(src) {
					out.WriteByte(src[i])
					i++
					out.WriteByte(src[i])
					continue
				}
				out.WriteByte(src[i])
				if src[i] == quote || (quote == '"' && src[i] == '\n') {
					break
				}
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
			if i < len(src) {
				out.WriteByte('\n') // keep line numbering intact
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			for i += 2; i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/'); i++ {
				if src[i] == '\n' {
					out.WriteByte('\n')
				}
			}
			i++ // land on the '/' of the closing pair; the loop's i++ steps past it
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// ── the scenario guard's own parts, tested (#2566) ──────────────────────────────────────────
//
// #2581 fixed four defects in the guard above and verified each by hand — deleting a real call from
// the real assembler, moving acmCert to the last position — then reverted the mutation. None of it
// survived the commit, so the guard that had already failed silently once was left with its
// discriminating branch unexercised again. These are those checks, kept.

func TestStripGoCommentsIgnoresStringLiterals(t *testing.T) {
	for _, tc := range []struct{ name, src, want, absent string }{
		{
			name:   "a line comment outside a string is removed",
			src:    "a := 1 // applyToSnapshot(\nb := 2",
			absent: "applyToSnapshot",
		},
		{
			name:   "a block comment outside a string is removed",
			src:    "a := 1\n/* func (c X) applyToSnapshot( */\nb := 2",
			absent: "applyToSnapshot",
		},
		{
			// THE HAZARD. `//` inside a URL is ordinary, and cutting the line at it truncates real
			// code — including, in the worst case, a definition, which drops that scenario out of
			// `defined` entirely and exempts it silently. That is the #1773 failure mode.
			name: "a '//' inside an interpreted string is not a comment",
			src:  `u := "https://example.com/x"` + "\n",
			want: "https://example.com/x",
		},
		{
			// A glob is the realistic way `/*` reaches a string. Non-greedy `/\*.*?\*/` would open a
			// comment here and swallow everything up to the next `*/` anywhere in the file.
			name: "a '/*' inside a string does not open a comment",
			src:  "g := \"**/*.go\"\nfunc (c acmCertConfig) applyToSnapshot(s any) {}\nh := \"a*/b\"",
			want: "applyToSnapshot",
		},
		{
			name: "a raw string literal is copied verbatim",
			src:  "r := `a // b /* c */ d`\n",
			want: "a // b /* c */ d",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := stripGoComments(tc.src)
			if tc.want != "" && !strings.Contains(got, tc.want) {
				t.Errorf("stripGoComments dropped %q:\nin:  %q\nout: %q", tc.want, tc.src, got)
			}
			if tc.absent != "" && strings.Contains(got, tc.absent) {
				t.Errorf("stripGoComments kept %q, which was inside a comment:\nout: %q", tc.absent, got)
			}
		})
	}
}

func TestScenarioDefinerMatchesEveryReceiverForm(t *testing.T) {
	// Each of these is idiomatic Go no reviewer would flag, and the first version matched only the
	// first. A scenario written either of the other two ways never entered `defined`, so the guard
	// reported green on a completely unwired scenario — #1773 again.
	for _, tc := range []struct{ name, src, want string }{
		{"single-letter value receiver", "func (c acmCertConfig) applyToSnapshot(", "acmCertConfig"},
		{"multi-character receiver", "func (cfg acmCertConfig) applyToSnapshot(", "acmCertConfig"},
		{"pointer receiver", "func (c *acmCertConfig) applyToSnapshot(", "acmCertConfig"},
		{"pointer + multi-character", "func (cfg *acmCertConfig) applyToSnapshot(", "acmCertConfig"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := scenarioDefinerRe.FindStringSubmatch(tc.src)
			if m == nil {
				t.Fatalf("no match for %q — a scenario written this way would be silently exempt", tc.src)
			}
			if m[1] != tc.want {
				t.Errorf("captured %q, want the receiver TYPE %q", m[1], tc.want)
			}
		})
	}
}

func TestScenarioAssemblerIsAnchoredToADeclaration(t *testing.T) {
	// The guard nominated its own file as the assembler because it matched the literal anywhere.
	// Anchoring is what makes a mention in prose or in a string not a declaration.
	if m := scenarioAssemblerRe.FindStringSubmatch("func t2DeploySnapshot(a A, b B) (X, error) {"); m == nil {
		t.Fatal("the real declaration must match")
	}
	for _, notADecl := range []string{
		`// see func t2DeploySnapshot(a A) (X, error) {`,
		`	s := "func t2DeploySnapshot(a A) (X, error) {"`,
		`x := someFunc t2DeploySnapshot(a A) (X, error) {`,
	} {
		if scenarioAssemblerRe.MatchString(notADecl) {
			t.Errorf("a non-declaration nominated a file as the assembler: %q", notADecl)
		}
	}
}

func TestScenarioParamResolvesTheLastParameter(t *testing.T) {
	// `sig` is captured WITHOUT its closing paren, so the old `(?:,|\))` alternation had a dead
	// branch and only a trailing comma terminated a parameter. The end of the signature is exactly
	// where the next scenario gets appended — which is where acmCert went.
	for _, sig := range []string{
		"a TypeA, b TypeB, acmCert acmCertConfig",
		"\n\ta TypeA,\n\tacmCert acmCertConfig,\n",
	} {
		// Keyed by TYPE, valued by the parameter NAME — the direction the guard uses to turn a
		// scenario's type into the variable the assembler calls it on. (I had this backwards first;
		// the regex was right and the test was wrong.)
		paramOf := map[string]string{}
		for _, m := range scenarioParamRe.FindAllStringSubmatch(sig, -1) {
			paramOf[m[2]] = m[1]
		}
		if paramOf["acmCertConfig"] != "acmCert" {
			t.Errorf("the LAST parameter did not resolve in %q: got %#v", sig, paramOf)
		}
	}
}
