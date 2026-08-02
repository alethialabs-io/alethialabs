// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Go half of the apps-path grammar mirror lock (#1767).
//
// `apps/console/lib/validations/apps-path.ts` validates the overlay path a user types in the
// inspector. This file is the authority: `ValidateAppsPath` is what actually runs before the path
// is rendered into an ArgoCD Application, and it fails closed on traversals and YAML-hostile runes.
// The console's copy exists so a user gets told at config time instead of at deploy time.
//
// The two are hand-written, and they must not disagree. The dangerous direction is the console
// being LOOSER: a path the form accepts and the runner then refuses is a deploy that fails after
// the user was told the value was fine. The other direction is merely annoying. Either way the
// repo's rule is that a hand-mirrored constant is drift detection at best, so the drift has to be
// detected by something rather than by someone reading the two side by side — which is exactly what
// the TS file's own comment says it should not rely on.
//
// Same shape as categories/secrets_runtime_read_mirror_test.go: read the TS as text, assert it
// against the live Go values. Untagged and pure — no cloud, no docker. Skips outside a monorepo
// checkout, so a consumer vendoring packages/core alone does not fail on a file that was never
// meant to be there.

package argocd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

const appsPathMirror = "apps/console/lib/validations/apps-path.ts"

// appsPathMirrorRoot walks up to the monorepo root, identified by go.work. "" when this is not a
// monorepo checkout.
func appsPathMirrorRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

var (
	tsSegmentRe = regexp.MustCompile(`const APPS_PATH_SEGMENT\s*=\s*/(.+?)/;`)
	tsMaxLenRe  = regexp.MustCompile(`const APPS_PATH_MAX_LEN\s*=\s*(\d+);`)
)

func TestAppsPathGrammarMirrorsTheConsole(t *testing.T) {
	root := appsPathMirrorRoot(t)
	if root == "" {
		t.Skip("not a monorepo checkout — no console to mirror")
	}
	raw, err := os.ReadFile(filepath.Join(root, appsPathMirror))
	if err != nil {
		t.Fatalf("read %s: %v", appsPathMirror, err)
	}
	src := string(raw)

	seg := tsSegmentRe.FindStringSubmatch(src)
	if seg == nil {
		t.Fatalf("%s: could not find APPS_PATH_SEGMENT — the shape changed; update tsSegmentRe rather than deleting this test", appsPathMirror)
	}
	if got, want := seg[1], appsPathSegmentRe.String(); got != want {
		t.Errorf("segment grammar has drifted.\n  console (%s): %s\n  Go (authority):        %s\n"+
			"A console pattern LOOSER than this one accepts a path the runner then refuses, after the "+
			"user was told it was fine.", appsPathMirror, got, want)
	}

	max := tsMaxLenRe.FindStringSubmatch(src)
	if max == nil {
		t.Fatalf("%s: could not find APPS_PATH_MAX_LEN — the shape changed; update tsMaxLenRe", appsPathMirror)
	}
	if got, want := max[1], fmt.Sprint(appsPathMaxLen); got != want {
		t.Errorf("length bound has drifted: console says %s, Go says %s", got, want)
	}
}

// The mirror test proves the two constants agree. This proves the constant Go actually ENFORCES is
// the one being mirrored — otherwise the pair could agree with each other and both disagree with
// the validator, which is the failure the mirror is supposed to make impossible.
func TestAppsPathBoundIsTheOneEnforced(t *testing.T) {
	atBound := ""
	for len(atBound) < appsPathMaxLen {
		atBound += "a"
	}
	if err := ValidateAppsPath(atBound); err != nil {
		t.Errorf("a path of exactly appsPathMaxLen (%d) was rejected: %v", appsPathMaxLen, err)
	}
	if err := ValidateAppsPath(atBound + "a"); err == nil {
		t.Errorf("a path one over appsPathMaxLen (%d) was accepted", appsPathMaxLen)
	}
}
