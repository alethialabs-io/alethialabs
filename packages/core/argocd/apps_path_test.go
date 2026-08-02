// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"
)

// TestValidateAppsPath is the guard's real spec. It runs in microseconds, so a traversal or a
// YAML-escape regression fails here rather than in a two-hour nightly — or, worse, in a tenant's
// cluster syncing a directory they never asked for.
func TestValidateAppsPath(t *testing.T) {
	valid := []struct {
		name string
		path string
	}{
		{"empty means the repo root", ""},
		{"explicit dot means the repo root", "."},
		{"whitespace only is still the repo root", "   "},
		{"a single segment", "manifests"},
		{"the canonical overlay layout", "overlays/dev"},
		{"a deeper layout", "k8s/overlays/staging"},
		{"dots, underscores and dashes inside a segment", "a.b_c-d/e.f"},
		{"a numeric segment", "v2/overlays/dev"},
		{"exactly at the length bound", strings.Repeat("a", appsPathMaxLen)},
	}
	for _, tc := range valid {
		t.Run("valid/"+tc.name, func(t *testing.T) {
			if err := ValidateAppsPath(tc.path); err != nil {
				t.Fatalf("ValidateAppsPath(%q) = %v, want nil", tc.path, err)
			}
		})
	}

	invalid := []struct {
		name string
		path string
	}{
		// Repo-root escape — the reason this guard exists.
		{"bare traversal", ".."},
		{"leading traversal", "../etc"},
		{"double traversal", "../../etc"},
		{"traversal in the middle", "overlays/../../etc"},
		{"traversal that normalises back inside", "overlays/../dev"},
		{"absolute path", "/abs/path"},
		{"absolute root", "/"},
		// Non-canonical forms: refused rather than silently rewritten, so what the user typed is
		// what ArgoCD gets or they are told it is wrong.
		{"trailing slash", "overlays/dev/"},
		{"double slash", "overlays//dev"},
		{"leading dot segment", "./overlays/dev"},
		// YAML-scalar escape from `path: '{{ .AppsPath }}'`.
		{"single quote", "over'lays"},
		{"double quote", "over\"lays"},
		{"backtick", "over`lays`"},
		{"dollar expansion", "$(whoami)"},
		{"brace expansion", "${HOME}"},
		{"space", "over lays"},
		{"newline", "overlays\ndev"},
		{"carriage return", "overlays\rdev"},
		{"tab inside", "overlays\tdev"},
		{"colon", "overlays:dev"},
		{"segment starting with a dash", "-overlays"},
		{"segment starting with a dot", ".hidden/dev"},
		{"empty segment via leading slash already covered, trailing dot segment", "overlays/."},
		// Bound.
		{"one over the length bound", strings.Repeat("a", appsPathMaxLen+1)},
	}
	for _, tc := range invalid {
		t.Run("invalid/"+tc.name, func(t *testing.T) {
			if err := ValidateAppsPath(tc.path); err == nil {
				t.Fatalf("ValidateAppsPath(%q) = nil, want an error — this value must never reach an ArgoCD Application source.path", tc.path)
			}
		})
	}
}

// TestValidateAppsPathRefusesRatherThanNormalises pins the deliberate choice not to "fix" a
// traversal. path.Clean would happily turn "../../shared" into "shared" — handing the user a
// different directory than the one they asked for, silently. Refusing is the honest behaviour, and
// this test exists so a future reviewer's "just Clean it" suggestion fails loudly.
func TestValidateAppsPathRefusesRatherThanNormalises(t *testing.T) {
	const hostile = "../../shared"
	err := ValidateAppsPath(hostile)
	if err == nil {
		t.Fatalf("ValidateAppsPath(%q) = nil — a traversal must be REFUSED, never normalised to %q", hostile, "shared")
	}
	if !strings.Contains(err.Error(), "shared") {
		t.Fatalf("the error should name the normalised form so the user can see what was actually asked for; got %q", err.Error())
	}
}
