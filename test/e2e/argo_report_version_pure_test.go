// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A diagnostic must not render a version it did not read.
//
// THE DEFECT THIS PINS. `describeArgoDiffStrategy` emitted the literal "argo-cd v3.1.8's controller
// compared with STRUCTURED-MERGE diff …". When the chart pin moved to 9.5.11 → argo-cd v3.3.9
// (#3128) the sentence did not move with it, so every subsequent run reported the version the
// cluster had NOT been running — and it briefly convinced a reader that hetzner/addons run
// 33162842830 had used the pre-bump ArgoCD when its SHA provably contained the bump.
//
// It is the repo's own recurring class: a message that renders a stale fact and survives every
// check, because a string literal compiles, lints, passes `gofmt` and reads plausibly. So the fix
// is not "update the number" — it is that the number can no longer be typed here at all. The report
// reads the running controller's image tag, and this test refuses a version literal in any string
// the diagnostic emits.
package e2e

import (
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// argoReportVersionScannedFiles are the sources whose EMITTED strings may not name a version.
//
// Comments are deliberately out of scope and are not scanned: they are provenance ("read out of the
// tree at v3.1.8"), they cost a reader nothing when the pin moves, and stripping them would delete
// the record of where the mechanism was established. Only string literals reach a run's output.
var argoReportVersionScannedFiles = []string{
	"argo_predicted_live.go",
	"argo_ssd_experiment.go",
}

// argoVersionLiteral matches a semantic version with or without the `v`. Three components, so a
// bare major.minor (a chart series, an API version) does not trip it.
var argoVersionLiteral = regexp.MustCompile(`\bv?\d+\.\d+\.\d+\b`)

func TestArgoReportEmitsNoHardcodedVersion(t *testing.T) {
	scanned := 0
	for _, name := range argoReportVersionScannedFiles {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			// A guard that cannot read its subject has found NOTHING, not "nothing wrong".
			t.Fatalf("could not parse %s, so this guard proved nothing: %v", name, err)
		}
		literals := 0
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			literals++
			value, uerr := strconv.Unquote(lit.Value)
			if uerr != nil {
				value = lit.Value
			}
			if m := argoVersionLiteral.FindString(value); m != "" {
				t.Errorf(`%s: the string literal %q hardcodes the version %q.
A report may only name a version it READ from the cluster (readArgoControllerVersion), because a
literal here survives a chart-pin bump and then reports the wrong ArgoCD on every run — which is
exactly what "argo-cd v3.1.8's controller" did after #3128. Put the provenance in a COMMENT and
render the running version from a parameter.`,
					fset.Position(lit.Pos()), value, m)
			}
			return true
		})
		// "Found no version literal" and "found no literals" print the same result otherwise.
		if literals == 0 {
			t.Fatalf("%s yielded ZERO string literals — the scan did not work, so its silence is not a pass", name)
		}
		scanned++
	}
	if scanned != len(argoReportVersionScannedFiles) {
		t.Fatalf("scanned %d of %d files", scanned, len(argoReportVersionScannedFiles))
	}
}

func TestDescribeArgoDiffStrategyReportsTheVersionItWasGiven(t *testing.T) {
	// The version must come from the ARGUMENT — a report that ignores what it was handed is the
	// same defect wearing a parameter.
	got := describeArgoDiffStrategy(argoAppDiffStrategySpec{
		SyncOptions: []string{"ServerSideApply=true"},
	}, "v3.3.9", nil)
	if !strings.Contains(got, "v3.3.9") {
		t.Fatalf("the strategy note must name the version it was given, got %q", got)
	}
	if strings.Contains(got, "v3.1.8") {
		t.Fatalf("the retired literal came back: %q", got)
	}
	// And it must say where it came from, so a reader knows it is a measurement and not a pin.
	if !strings.Contains(got, "read from the running application-controller image") {
		t.Fatalf("the note must attribute the version to the cluster read, got %q", got)
	}
}

func TestDescribeArgoDiffStrategyNamesNoVersionWhenItCannotReadOne(t *testing.T) {
	// The failure that matters: an unreadable version must not silently fall back to a literal, and
	// must not be silent either — "we did not read it" is its own finding.
	got := describeArgoDiffStrategy(argoAppDiffStrategySpec{
		SyncOptions: []string{"ServerSideApply=true"},
	}, "   ", nil)
	if m := argoVersionLiteral.FindString(got); m != "" {
		t.Fatalf("no version was read, yet the note names %q: %s", m, got)
	}
	if !strings.Contains(got, "could NOT be read") {
		t.Fatalf("an unread version must SAY it was not read, got %q", got)
	}
	// The verdict itself must survive — not knowing the version does not change which diff ran.
	if !strings.Contains(got, "STRUCTURED-MERGE") {
		t.Fatalf("the strategy verdict must not depend on knowing the version: %q", got)
	}
}

func TestArgoVersionFromImages(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want string
	}{
		{"plain", "quay.io/argoproj/argocd:v3.3.9", "v3.3.9"},
		{"several containers takes the first", "quay.io/argoproj/argocd:v3.3.9 redis:7.2", "v3.3.9"},
		{"registry port is not a tag", "registry.internal:5000/argocd:v3.3.9", "v3.3.9"},
		{"tag and digest keeps the tag", "quay.io/argoproj/argocd:v3.3.9@sha256:abc", "v3.3.9"},
		// The one that must NOT invent a version: a digest-pinned image carries none.
		{"digest only", "quay.io/argoproj/argocd@sha256:abcdef", ""},
		{"no tag", "quay.io/argoproj/argocd", ""},
		{"empty", "", ""},
		{"whitespace", "   \n ", ""},
		// A registry port with no tag must not be read as one — the bug a naive first-colon split
		// would ship, and it would render as `argo-cd 5000's controller`.
		{"registry port without a tag", "registry.internal:5000/argocd", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := argoVersionFromImages(tc.raw); got != tc.want {
				t.Fatalf("argoVersionFromImages(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestReadArgoControllerVersionWithoutAClusterReturnsNothing(t *testing.T) {
	// Not "" as a shrug: the caller turns "" into an explicit "could NOT be read", and the failure
	// mode being prevented is returning something that reads like a version.
	if got := readArgoControllerVersion(t.Context(), "/nonexistent-kubeconfig", "statefulset.apps/c"); got != "" {
		t.Fatalf("no cluster must yield no version, got %q", got)
	}
	if got := readArgoControllerVersion(t.Context(), "/nonexistent-kubeconfig", ""); got != "" {
		t.Fatalf("no workload must yield no version, got %q", got)
	}
}
