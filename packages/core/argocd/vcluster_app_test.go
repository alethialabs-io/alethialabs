// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"
)

// RenderVClusterApp had NO render-level coverage before this file — only its cluster-Secret sibling
// was tested. Wiring AppsPath is the moment to close that: the invariants below are ones the
// renderer already claims in its doc comments and template but nothing ever asserted.

func baseVClusterAppInput() VClusterAppInput {
	return VClusterAppInput{
		Project:      "demo",
		VClusterName: "tenant-vc",
		Namespace:    "workload",
		AppsRepoURL:  "https://github.com/acme/manifests",
		Labels:       map[string]string{"alethia.io/project": "demo"},
	}
}

func vclusterAppSpec(t *testing.T, app string) map[string]interface{} {
	t.Helper()
	doc := firstDocOfKind(t, decodeDocs(t, app), "Application")
	spec, ok := doc["spec"].(map[string]interface{})
	if !ok {
		t.Fatalf("Application has no spec:\n%s", app)
	}
	return spec
}

func TestRenderVClusterApp_FailsClosed(t *testing.T) {
	cases := map[string]VClusterAppInput{
		"missing project":       {VClusterName: "tenant-vc", AppsRepoURL: "https://github.com/acme/manifests"},
		"missing vcluster name": {Project: "demo", AppsRepoURL: "https://github.com/acme/manifests"},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := RenderVClusterApp(in); err == nil {
				t.Fatalf("expected fail-closed error, got nil")
			}
		})
	}
}

// TestRenderVClusterApp_DestinationAndNamespace pins the two claims that make this the vcluster path
// rather than the namespace path: the Application targets the registered vcluster BY NAME (not by
// server URL — that would be the host cluster), and it creates its namespace inside the vcluster on
// first sync, because a fresh vcluster is empty.
func TestRenderVClusterApp_DestinationAndNamespace(t *testing.T) {
	out, err := RenderVClusterApp(baseVClusterAppInput())
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	spec := vclusterAppSpec(t, out.App)
	dest, ok := spec["destination"].(map[string]interface{})
	if !ok {
		t.Fatalf("Application has no spec.destination:\n%s", out.App)
	}
	if got := toStr(dest["name"]); got != "tenant-vc" {
		t.Errorf("destination.name = %q, want tenant-vc — a vcluster app must route by registered cluster NAME", got)
	}
	if _, hasServer := dest["server"]; hasServer {
		t.Errorf("destination must not carry a server URL — that would target the HOST cluster, defeating the vcluster boundary:\n%s", out.App)
	}
	if got := toStr(dest["namespace"]); got != "workload" {
		t.Errorf("destination.namespace = %q, want workload", got)
	}
	if !strings.Contains(out.App, "CreateNamespace=true") {
		t.Errorf("a fresh vcluster is empty — the app must create its target namespace on first sync:\n%s", out.App)
	}
}

// TestRenderVClusterApp_NamespaceDefaults pins the documented fallback.
func TestRenderVClusterApp_NamespaceDefaults(t *testing.T) {
	in := baseVClusterAppInput()
	in.Namespace = ""
	out, err := RenderVClusterApp(in)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	dest := vclusterAppSpec(t, out.App)["destination"].(map[string]interface{})
	if got := toStr(dest["namespace"]); got != "default" {
		t.Errorf("empty namespace = %q, want default", got)
	}
}

// TestRenderVClusterApp_NoRepoProjectOnly mirrors the namespace tenant's fail-closed contract: no
// apps repo yields no Application at all and a sourceRepos allowlist that denies everything, never
// one that is silently wide open.
func TestRenderVClusterApp_NoRepoProjectOnly(t *testing.T) {
	in := baseVClusterAppInput()
	in.AppsRepoURL = ""
	out, err := RenderVClusterApp(in)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if out.App != "" {
		t.Errorf("no apps repo → expected no Application, got:\n%s", out.App)
	}
	proj := firstDocOfKind(t, decodeDocs(t, out.Project), "AppProject")
	repos := proj["spec"].(map[string]interface{})["sourceRepos"].([]interface{})
	if len(repos) != 1 || repos[0] != "!*" {
		t.Errorf("empty apps repo sourceRepos = %v, want [!*] (fail closed)", repos)
	}
}

// TestRenderVClusterApp_AppsPathDefaultsToRepoRoot — the backward-compatibility proof for the
// vcluster half. Byte-identical, for the same reason as the namespace tenant: an existing vcluster
// tenant syncing its repo root must not move.
func TestRenderVClusterApp_AppsPathDefaultsToRepoRoot(t *testing.T) {
	unset := baseVClusterAppInput()
	if unset.AppsPath != "" {
		t.Fatalf("fixture drift: baseVClusterAppInput must leave AppsPath unset")
	}
	unsetOut, err := RenderVClusterApp(unset)
	if err != nil {
		t.Fatalf("render (unset): %v", err)
	}
	if got := toStr(vclusterAppSpec(t, unsetOut.App)["source"].(map[string]interface{})["path"]); got != "." {
		t.Fatalf("unset AppsPath rendered source.path = %q, want \".\"", got)
	}

	explicit := baseVClusterAppInput()
	explicit.AppsPath = "."
	explicitOut, err := RenderVClusterApp(explicit)
	if err != nil {
		t.Fatalf("render (explicit dot): %v", err)
	}
	if unsetOut.App != explicitOut.App {
		t.Fatalf("unset and explicit \".\" must render byte-identically.\nunset:\n%s\nexplicit:\n%s", unsetOut.App, explicitOut.App)
	}
}

func TestRenderVClusterApp_AppsPathOverlay(t *testing.T) {
	in := baseVClusterAppInput()
	in.AppsPath = "overlays/staging"
	out, err := RenderVClusterApp(in)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if got := toStr(vclusterAppSpec(t, out.App)["source"].(map[string]interface{})["path"]); got != "overlays/staging" {
		t.Fatalf("source.path = %q, want overlays/staging", got)
	}

	baseline, err := RenderVClusterApp(baseVClusterAppInput())
	if err != nil {
		t.Fatalf("render (baseline): %v", err)
	}
	if out.Project != baseline.Project {
		t.Errorf("AppsPath must not change the AppProject half.\ngot:\n%s\nwant:\n%s", out.Project, baseline.Project)
	}
}

func TestRenderVClusterApp_AppsPathFailsClosed(t *testing.T) {
	hostile := []string{"../../etc", "/abs/path", "overlays/../../etc", "overlays/dev/", "over'lays", "$(whoami)", "overlays\ndev"}
	for _, p := range hostile {
		t.Run(p, func(t *testing.T) {
			in := baseVClusterAppInput()
			in.AppsPath = p
			out, err := RenderVClusterApp(in)
			if err == nil {
				t.Fatalf("AppsPath %q rendered without error", p)
			}
			if out.App != "" || out.Project != "" {
				t.Fatalf("fail-closed render must return a zero-value manifest, got App=%q Project=%q", out.App, out.Project)
			}
		})
	}
}
