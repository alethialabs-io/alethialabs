// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"
)

// appSourcePath decodes the tenant Application and returns its spec.source.path.
func appSourcePath(t *testing.T, app string) string {
	t.Helper()
	doc := firstDocOfKind(t, decodeDocs(t, app), "Application")
	src, ok := doc["spec"].(map[string]interface{})["source"].(map[string]interface{})
	if !ok {
		t.Fatalf("Application has no spec.source:\n%s", app)
	}
	return toStr(src["path"])
}

// TestRenderNamespaceTenant_AppsPathDefaultsToRepoRoot is THE backward-compatibility proof.
//
// Every namespace placement that predates repositories.apps_path syncs the repository root. If
// wiring the field moved that default even slightly, every existing tenant's Application would
// point somewhere new — Unknown or Degraded, with no deploy to explain it. Equivalence is not
// enough here: the unset render must be BYTE-IDENTICAL to the explicit "." render.
func TestRenderNamespaceTenant_AppsPathDefaultsToRepoRoot(t *testing.T) {
	unset := baseNamespaceTenantInput()
	if unset.AppsPath != "" {
		t.Fatalf("fixture drift: baseNamespaceTenantInput must leave AppsPath unset for this test to mean anything")
	}
	unsetOut, err := RenderNamespaceTenant(unset)
	if err != nil {
		t.Fatalf("render (unset): %v", err)
	}
	if got := appSourcePath(t, unsetOut.App); got != "." {
		t.Fatalf("unset AppsPath rendered source.path = %q, want \".\" (the repo root) — this is the pre-existing behaviour and it must not move", got)
	}

	explicit := baseNamespaceTenantInput()
	explicit.AppsPath = "."
	explicitOut, err := RenderNamespaceTenant(explicit)
	if err != nil {
		t.Fatalf("render (explicit dot): %v", err)
	}
	if unsetOut.App != explicitOut.App {
		t.Fatalf("unset and explicit \".\" must render byte-identically.\nunset:\n%s\nexplicit:\n%s", unsetOut.App, explicitOut.App)
	}
}

// TestRenderNamespaceTenant_AppsPathOverlay is the feature: a placed environment syncs its OWN tier
// rather than the whole repository. It also pins that the path never leaks into the isolation half —
// the Namespace and the hardened AppProject must be unchanged by it.
func TestRenderNamespaceTenant_AppsPathOverlay(t *testing.T) {
	in := baseNamespaceTenantInput()
	in.AppsPath = "overlays/dev"
	out, err := RenderNamespaceTenant(in)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if got := appSourcePath(t, out.App); got != "overlays/dev" {
		t.Fatalf("source.path = %q, want overlays/dev — without this a placement delivers the whole repo and the per-tier overlay claim is vacuous", got)
	}

	baseline, err := RenderNamespaceTenant(baseNamespaceTenantInput())
	if err != nil {
		t.Fatalf("render (baseline): %v", err)
	}
	if out.Isolation != baseline.Isolation {
		t.Errorf("AppsPath must not change the Namespace/AppProject isolation half.\ngot:\n%s\nwant:\n%s", out.Isolation, baseline.Isolation)
	}
}

// TestRenderNamespaceTenant_AppsPathFailsClosed proves the renderer refuses a hostile path outright
// rather than emitting a half-formed manifest. A partially rendered Application is worse than none:
// it would be applied.
func TestRenderNamespaceTenant_AppsPathFailsClosed(t *testing.T) {
	hostile := []string{
		"../../etc",
		"/abs/path",
		"overlays/../../etc",
		"overlays/dev/",
		"overlays//dev",
		"over'lays",
		"$(whoami)",
		"over lays",
		"overlays\ndev",
		strings.Repeat("a", appsPathMaxLen+1),
	}
	for _, p := range hostile {
		t.Run(p, func(t *testing.T) {
			in := baseNamespaceTenantInput()
			in.AppsPath = p
			out, err := RenderNamespaceTenant(in)
			if err == nil {
				t.Fatalf("AppsPath %q rendered without error — it would reach an ArgoCD Application source.path", p)
			}
			if out.App != "" || out.Isolation != "" {
				t.Fatalf("fail-closed render must return a zero-value manifest, got App=%q Isolation=%q", out.App, out.Isolation)
			}
		})
	}
}
