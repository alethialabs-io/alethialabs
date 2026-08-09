// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package imagebuild

import (
	"bufio"
	"strings"
	"testing"
)

// jobNameFromManifest pulls the Job's metadata.name out of a rendered manifest — the name the
// cluster will actually hold, which is the only thing worth comparing against.
func jobNameFromManifest(t *testing.T, manifest string) string {
	t.Helper()
	sc := bufio.NewScanner(strings.NewReader(manifest))
	for sc.Scan() {
		line := sc.Text()
		// The first `  name:` at metadata depth is the Job's own name (kind: Job is the first doc).
		if strings.HasPrefix(line, "  name: ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "  name:"))
		}
	}
	t.Fatalf("no metadata.name found in the rendered manifest:\n%s", manifest)
	return ""
}

// TestBuildJobNameMatchesTheRenderedManifest is #2032's contract test, and it is the one that would
// have caught the defect.
//
// The runner addresses the build Job by name for its pre-delete, its `kubectl get job` watch and its
// digest reads. The renderer bounds the name to 63 minus len("build-") = 57 characters; the runner's
// hand-written copy sanitized identically but applied NO budget. Past 57 characters the two answers
// diverged, the Job ran fine, and the watcher looked for something that does not exist.
//
// The pre-existing naming test only used short names, which is exactly why this survived — so the
// long case is the point of this one.
func TestBuildJobNameMatchesTheRenderedManifest(t *testing.T) {
	names := []string{
		"api",
		"My_API",
		" Web App ",
		// 57 sanitized chars: the exact budget boundary.
		strings.Repeat("a", 57),
		// 58: one past it — the shortest name that diverged.
		strings.Repeat("a", 58),
		// Comfortably past, with separators that sanitize to hyphens.
		strings.Repeat("service-name/segment.", 6),
		strings.Repeat("z", 200),
	}

	for _, n := range names {
		svc := repoService()
		svc.Name = n

		manifest, err := RenderBuildJob(svc, fullOpts())
		if err != nil {
			t.Fatalf("RenderBuildJob(%q): %v", n, err)
		}
		rendered := jobNameFromManifest(t, manifest)
		derived := BuildJobName(n)

		if derived != rendered {
			t.Errorf("BuildJobName(%q) = %q but the manifest creates %q — the watcher would address a Job that does not exist", n, derived, rendered)
		}
		if len(rendered) > dnsLabelMaxLen {
			t.Errorf("rendered Job name for %q is %d chars, over the %d-char DNS label limit: %q", n, len(rendered), dnsLabelMaxLen, rendered)
		}
		if strings.HasSuffix(rendered, "-") || strings.HasPrefix(rendered, "-") {
			t.Errorf("rendered Job name for %q is hyphen-bounded and not a valid DNS label: %q", n, rendered)
		}
	}
}

// TestBuildJobNameRespectsTheLabelBudget states the budget directly, so a future change to
// buildNamePrefix that forgets to re-derive the cap fails here rather than in a real build.
func TestBuildJobNameRespectsTheLabelBudget(t *testing.T) {
	got := BuildJobName(strings.Repeat("a", 500))
	if len(got) != dnsLabelMaxLen {
		t.Errorf("a maximally long name should saturate the 63-char label: got %d chars (%q)", len(got), got)
	}
	if !strings.HasPrefix(got, buildNamePrefix) {
		t.Errorf("BuildJobName lost its %q prefix: %q", buildNamePrefix, got)
	}
}
