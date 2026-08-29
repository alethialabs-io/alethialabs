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
//
// ⚠️ EVERY diagnostic in the shared helper belongs here. This list held three of seven, so both
// tests below passed with four of them deleted from `argoDeadlineDump` — the exact #2834 drift the
// file exists to prevent, tolerated by the guard against it. A guard whose subject list is written
// once and never grown decays into a guard for whatever was true the day it was written.
//
// Add a diagnostic to argoDeadlineDump, add it here.
var dumpHelpers = []string{
	"dumpArgoSyncFailures",
	"dumpPendingHooks",
	"dumpAddOnBootstrapJobs",
	"dumpArgoControllerLog",
	"dumpDestinationWarnings",
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

// The OTHER direction, which is the one that let this list rot: a diagnostic added to the shared
// helper and never added to dumpHelpers is unguarded, and nothing said so.
//
// Every `dump*`/`describe*` call in the helper's body must be named above. That is a mechanical
// question about the body, so it cannot fall behind the way a hand-maintained list does.
func TestDumpHelpersNamesEveryDiagnosticTheHelperCalls(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("argocd_assert.go")
	if err != nil {
		t.Fatalf("could not read argocd_assert.go: %v", err)
	}
	body := regexp.MustCompile(`(?s)func argoDeadlineDump\(.*?\n}\n`).FindString(string(raw))
	if body == "" {
		t.Fatal("argoDeadlineDump not found — this test would be vacuous")
	}
	called := regexp.MustCompile(`\b((?:dump|describe)[A-Za-z0-9_]*)\(`).FindAllStringSubmatch(body, -1)
	if len(called) == 0 {
		t.Fatal("no diagnostic calls found in argoDeadlineDump — the pattern no longer matches its body")
	}
	named := map[string]bool{}
	for _, h := range dumpHelpers {
		named[h] = true
	}
	for _, m := range called {
		if m[1] == "argoDeadlineDump" {
			continue
		}
		if !named[m[1]] {
			t.Errorf("argoDeadlineDump calls %s but dumpHelpers does not name it — that diagnostic "+
				"can be deleted, or duplicated into a second wait, with both guards still green", m[1])
		}
	}
}
