// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"
)

func baseNamespaceTenantInput() NamespaceTenantInput {
	return NamespaceTenantInput{
		Project:     "demo",
		Namespace:   "production",
		AppsRepoURL: "https://github.com/acme/manifests",
		Labels:      map[string]string{"alethia.io/project": "demo"},
	}
}

// firstDocOfKind returns the first decoded doc of the given kind, or fails.
func firstDocOfKind(t *testing.T, docs []map[string]interface{}, kind string) map[string]interface{} {
	t.Helper()
	for _, d := range docs {
		if d["kind"] == kind {
			return d
		}
	}
	t.Fatalf("no %s doc found", kind)
	return nil
}

func TestRenderNamespaceTenant_FailsClosed(t *testing.T) {
	cases := map[string]NamespaceTenantInput{
		"missing project":   {Namespace: "production", AppsRepoURL: "https://github.com/acme/manifests"},
		"missing namespace": {Project: "demo", AppsRepoURL: "https://github.com/acme/manifests"},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := RenderNamespaceTenant(in); err == nil {
				t.Fatalf("expected fail-closed error, got nil")
			}
		})
	}
}

func TestRenderNamespaceTenant_HardenedIsolation(t *testing.T) {
	out, err := RenderNamespaceTenant(baseNamespaceTenantInput())
	if err != nil {
		t.Fatalf("render: %v", err)
	}

	// ── Namespace: PSA baseline enforce + placement label ────────────────────────────────
	isoDocs := decodeDocs(t, out.Isolation)
	nsDoc := firstDocOfKind(t, isoDocs, "Namespace")
	if got := nsDoc["metadata"].(map[string]interface{})["name"]; got != "production" {
		t.Errorf("namespace name = %v, want production", got)
	}
	nsLabels := labelsOf(t, nsDoc)
	if nsLabels["pod-security.kubernetes.io/enforce"] != "baseline" {
		t.Errorf("PSA enforce = %q, want baseline", nsLabels["pod-security.kubernetes.io/enforce"])
	}
	if nsLabels["pod-security.kubernetes.io/warn"] != "restricted" {
		t.Errorf("PSA warn = %q, want restricted", nsLabels["pod-security.kubernetes.io/warn"])
	}
	if nsLabels["alethia.io/placement"] != "namespace" {
		t.Errorf("placement label = %q, want namespace", nsLabels["alethia.io/placement"])
	}
	if nsLabels["alethia.io/project"] != "demo" {
		t.Errorf("classification label not stamped on namespace: %v", nsLabels)
	}

	// ── AppProject: hardened, single-namespace, guardrail + argocd kinds blacklisted ──────
	proj := firstDocOfKind(t, isoDocs, "AppProject")
	spec := proj["spec"].(map[string]interface{})

	// clusterResourceWhitelist MUST be empty — no cluster-scoped resource may be created.
	if cw, ok := spec["clusterResourceWhitelist"].([]interface{}); !ok || len(cw) != 0 {
		t.Errorf("clusterResourceWhitelist = %v, want empty (no cluster-scoped escape)", spec["clusterResourceWhitelist"])
	}

	// sourceRepos pinned to the tenant apps repo only.
	repos := spec["sourceRepos"].([]interface{})
	if len(repos) != 1 || repos[0] != "https://github.com/acme/manifests" {
		t.Errorf("sourceRepos = %v, want the single tenant repo", repos)
	}

	// destination pinned to in-cluster + the single namespace.
	dests := spec["destinations"].([]interface{})
	if len(dests) != 1 {
		t.Fatalf("destinations = %v, want exactly one", dests)
	}
	d0 := dests[0].(map[string]interface{})
	if d0["server"] != "https://kubernetes.default.svc" || d0["namespace"] != "production" {
		t.Errorf("destination = %v, want in-cluster + production", d0)
	}

	// namespaceResourceBlacklist must deny the guardrail kinds AND argoproj.io Application/AppProject.
	bl := spec["namespaceResourceBlacklist"].([]interface{})
	wantBlacklisted := map[string]bool{
		"networking.k8s.io/NetworkPolicy":       false,
		"/ResourceQuota":                        false,
		"/LimitRange":                           false,
		"rbac.authorization.k8s.io/Role":        false,
		"rbac.authorization.k8s.io/RoleBinding": false,
		"argoproj.io/Application":               false,
		"argoproj.io/AppProject":                false,
	}
	for _, e := range bl {
		m := e.(map[string]interface{})
		key := toStr(m["group"]) + "/" + toStr(m["kind"])
		if _, ok := wantBlacklisted[key]; ok {
			wantBlacklisted[key] = true
		}
	}
	for key, seen := range wantBlacklisted {
		if !seen {
			t.Errorf("namespaceResourceBlacklist missing %q", key)
		}
	}

	// ── App Application: pinned to the hardened project, in-cluster + ns, CreateNamespace=false ──
	appDocs := decodeDocs(t, out.App)
	app := firstDocOfKind(t, appDocs, "Application")
	appSpec := app["spec"].(map[string]interface{})
	projName := proj["metadata"].(map[string]interface{})["name"]
	if appSpec["project"] != projName {
		t.Errorf("app project = %v, want the hardened AppProject %v (never infra/apps)", appSpec["project"], projName)
	}
	appDest := appSpec["destination"].(map[string]interface{})
	if appDest["server"] != "https://kubernetes.default.svc" || appDest["namespace"] != "production" {
		t.Errorf("app destination = %v, want in-cluster + production", appDest)
	}
	if !strings.Contains(out.App, "CreateNamespace=false") {
		t.Errorf("app must set CreateNamespace=false (guardrails own the namespace):\n%s", out.App)
	}
}

func TestRenderNamespaceTenant_NoRepoIsolationOnly(t *testing.T) {
	in := baseNamespaceTenantInput()
	in.AppsRepoURL = ""
	out, err := RenderNamespaceTenant(in)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if out.App != "" {
		t.Errorf("no apps repo → expected no App Application, got:\n%s", out.App)
	}
	// sourceRepos must fail closed to "!*" (deny everything), never wide open.
	proj := firstDocOfKind(t, decodeDocs(t, out.Isolation), "AppProject")
	repos := proj["spec"].(map[string]interface{})["sourceRepos"].([]interface{})
	if len(repos) != 1 || repos[0] != "!*" {
		t.Errorf("empty apps repo sourceRepos = %v, want [!*] (fail closed)", repos)
	}
}

func toStr(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
