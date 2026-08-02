// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"path"
	"regexp"
	"strings"
)

// The apps-repo subpath a PLACED environment syncs — the per-tier Kustomize overlay
// ("overlays/dev") that makes a namespace/vcluster placement deliver its OWN tier rather than the
// whole repo. It is user-controlled project data, and it lands verbatim in an ArgoCD Application's
// `source.path`, so it is validated at the renderers' choke point (NamespaceTenantInput.validate /
// VClusterAppInput.validate) and again in the provisioner before any cluster is touched.
//
// The threat is NOT shell injection: kubectlApplyManifest writes the rendered manifest to a temp
// file and applies `-f <file>`, so the path only ever lives in file CONTENT. What must be prevented
// is (a) breaking out of the single-quoted YAML scalar in `path: '{{ .AppsPath }}'`, and (b) ArgoCD
// resolving a path outside the repo root.

// appsPathSegmentRe is the conservative repo-subpath segment grammar: an alphanumeric start, then
// alphanumerics, '.', '_' or '-'. Quotes, backticks, '$', spaces, newlines and every other
// YAML-hostile rune are excluded BY CONSTRUCTION rather than by a denylist that must be kept ahead
// of the next idea for an escape.
var appsPathSegmentRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// appsPathMaxLen bounds the rendered scalar. Far above any real Kustomize layout, low enough that a
// pathological value cannot bloat every generated manifest.
const appsPathMaxLen = 512

// ValidateAppsPath fails closed on an apps-repo subpath that is absolute, escapes the repo root, or
// carries a rune that could break out of the YAML scalar it renders into.
//
// EMPTY IS VALID and means the repository root: templateData defaults it to "." so an unset path
// renders byte-identically to every deploy that predates this field. That is the whole
// backward-compatibility contract — an existing tenant whose apps repo syncs at its root must not
// move.
//
// Modelled on resolveByoModuleDir (provisioner/byo_iac.go), but LEXICAL ONLY: there is no local
// clone to resolve against, because ArgoCD resolves this path remotely at sync time. It also uses
// `path` rather than `filepath` — a git path is slash-separated regardless of host, so the guard
// must behave identically on a darwin dev box and the linux runner.
//
// A traversal is REFUSED, never normalised. Rewriting "../../shared" to "shared" would silently
// hand the user a different directory than the one they asked for.
func ValidateAppsPath(p string) error {
	p = strings.TrimSpace(p)
	if p == "" || p == "." {
		return nil
	}
	if len(p) > appsPathMaxLen {
		return fmt.Errorf("apps path is too long (%d chars, max %d)", len(p), appsPathMaxLen)
	}
	if strings.HasPrefix(p, "/") {
		return fmt.Errorf("apps path %q must be relative to the apps repo root, not absolute", p)
	}
	// path.Clean("/"+p) collapses any leading ".." against a virtual root. If the normalised form
	// differs from the input, the input was not already a clean, root-anchored subpath — so
	// "../../etc" (which normalises to "etc") is rejected here rather than quietly rewritten, and
	// so are "overlays//dev" and a trailing "overlays/dev/".
	if clean := strings.TrimPrefix(path.Clean("/"+p), "/"); clean != p {
		return fmt.Errorf("apps path %q is not a clean repo-relative subpath (normalises to %q)", p, clean)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." || !appsPathSegmentRe.MatchString(seg) {
			return fmt.Errorf("apps path %q has an invalid segment %q — allowed: alphanumerics, '.', '_' and '-'", p, seg)
		}
	}
	return nil
}
