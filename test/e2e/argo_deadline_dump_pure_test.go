// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// There are two ArgoCD convergence waits — AssertArgoAppsHealthy and the A0.6 repo-apps wait — and
// each used to assemble its own timeout dump by hand. #2834 added the desired-vs-live diff to one
// and not the other, so hetzner/maxconfig run 32993552300 timed out with five OutOfSync
// StatefulSets and printed NO diff: A0.6 was enabled, so the run went through the other wait.
//
// The fix was one shared `argoDeadlineDump`. This test is what keeps it one: a third wait that
// assembles its own list would drift the same way, and the drift is invisible until a run needs the
// missing half — by which point it has cost a real apply.

package e2e

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// dumpHelpers are the diagnostics a timed-out wait must carry. Calling any of them outside
// argoDeadlineDump means a caller is building its own dump.
var dumpHelpers = []string{
	"describeArgoApps",
	"dumpOutOfSyncResources",
	"dumpArgoAppDiffs",
}

func TestEveryDeadlineDumpGoesThroughTheSharedHelper(t *testing.T) {
	t.Parallel()

	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("could not list package sources (%v) — this test cannot check anything", err)
	}

	// The helper's own body is the one legitimate caller, so it is excised before scanning.
	bodyOf := regexp.MustCompile(`(?s)func argoDeadlineDump\(.*?\n}\n`)

	var offenders []string
	sawHelperDefinition := false
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, rerr := os.ReadFile(f)
		if rerr != nil {
			t.Fatalf("could not read %s: %v", f, rerr)
		}
		src := string(raw)
		if strings.Contains(src, "func argoDeadlineDump(") {
			sawHelperDefinition = true
			src = bodyOf.ReplaceAllString(src, "")
		}
		for _, line := range strings.Split(src, "\n") {
			trimmed := strings.TrimSpace(line)
			// Definitions and doc comments are not calls.
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "func ") {
				continue
			}
			for _, helper := range dumpHelpers {
				if strings.Contains(trimmed, helper+"(") {
					offenders = append(offenders, f+": "+trimmed)
				}
			}
		}
	}

	// Guards the guard: if the helper is renamed or the glob stops matching, the scan above would
	// find nothing and report success while checking nothing.
	if !sawHelperDefinition {
		t.Fatal("argoDeadlineDump is not defined in this package — the scan checked nothing")
	}

	if len(offenders) > 0 {
		t.Fatalf("these call a deadline-dump helper directly instead of argoDeadlineDump, which is "+
			"how one wait ends up with diagnostics the other lacks:\n  %s",
			strings.Join(offenders, "\n  "))
	}
}

func TestSharedDumpCarriesEveryDiagnostic(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("argocd_assert.go")
	if err != nil {
		t.Fatalf("could not read argocd_assert.go: %v", err)
	}
	body := regexp.MustCompile(`(?s)func argoDeadlineDump\(.*?\n}\n`).FindString(string(raw))
	if body == "" {
		t.Fatal("argoDeadlineDump not found — the test above would also be vacuous")
	}
	// Dropping one from the shared helper is the same defect as before, moved one level up: every
	// wait would lose it at once instead of one wait lacking it.
	for _, helper := range dumpHelpers {
		if !strings.Contains(body, helper+"(") {
			t.Errorf("argoDeadlineDump no longer calls %s — every ArgoCD timeout loses it", helper)
		}
	}
}

// The budget's job is to stop the dump killing teardown; the SKIPPED LIST's job is to stop it doing
// that quietly. A dump that ends early without saying so reads as a complete dump with nothing in
// its later sections, which is the same defect the whole file exists to prevent.
func TestRenderDumpBudgetSpentNamesWhatDidNotRun(t *testing.T) {
	t.Parallel()

	if got := renderDumpBudgetSpent(nil); got != "" {
		t.Errorf("nothing skipped must print nothing, got %q", got)
	}
	got := renderDumpBudgetSpent([]dumpSection{{name: "describe"}, {name: "argocd app diff"}})
	for _, want := range []string{"2 section(s) NOT run", "describe", "argocd app diff", argoDumpBudget.String()} {
		if !strings.Contains(got, want) {
			t.Errorf("the skipped notice does not carry %q:\n%s", want, got)
		}
	}
}

// Every section the dump declares must be NAMED, or the skipped notice reports a blank.
func TestEveryDumpSectionHasAName(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("argocd_assert.go")
	if err != nil {
		t.Fatalf("could not read argocd_assert.go: %v", err)
	}
	body := regexp.MustCompile(`(?s)sections := \[\]dumpSection\{.*?\n\t\}\n`).FindString(string(raw))
	if body == "" {
		t.Fatal("the section table was not found — this test would be vacuous")
	}
	entries := regexp.MustCompile(`\{"([^"]*)", func\(\) string`).FindAllStringSubmatch(body, -1)
	if len(entries) == 0 {
		t.Fatal("no sections matched — the table's shape changed and this test stopped checking")
	}
	// Deliberately NOT compared against len(dumpHelpers): #3373 adds a test that derives every
	// diagnostic call from the helper's body and requires it to be named there, which checks the
	// same drift by NAME rather than by count. A count check here would only duplicate it, and it
	// would couple this test to a list that lives on another branch.
	for _, e := range entries {
		if strings.TrimSpace(e[1]) == "" {
			t.Error("a dump section has an empty name; the skipped notice would report a blank")
		}
	}
}
