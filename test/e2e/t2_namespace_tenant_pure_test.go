// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure unit tests for the namespace-placement scenario helpers (#959) — no cloud, no Postgres, no
// build tag, so they run in ordinary `go test`.
package e2e

import "testing"

func TestNamespaceTenantSlug(t *testing.T) {
	cases := map[string]string{
		"production":  "e2e-ns-production",
		"Staging Env": "e2e-ns-staging-env",
		"":            "e2e-ns-env",
	}
	for in, want := range cases {
		if got := namespaceTenantSlug(in); got != want {
			t.Errorf("namespaceTenantSlug(%q) = %q, want %q", in, got, want)
		}
	}
	if len(namespaceTenantSlug("a-very-long-environment-name-that-blows-past-the-sixty-three-character-limit")) > 63 {
		t.Errorf("slug exceeded 63 chars")
	}
}

func TestBuildNamespaceSnapshot(t *testing.T) {
	p := namespaceTenantParams{project: "shop", env: "prod", provider: "aws", region: "us-east-1", fabricClust: "eks-fabric", appsRepo: "https://github.com/acme/manifests"}
	snap := buildNamespaceSnapshot(p, "e2e-ns-prod")
	if snap["placement_mode"] != "namespace" {
		t.Errorf("placement_mode = %v", snap["placement_mode"])
	}
	if snap["namespace"] != "e2e-ns-prod" {
		t.Errorf("namespace = %v", snap["namespace"])
	}
	cl, _ := snap["cluster"].(map[string]any)
	if cl["cluster_name"] != "eks-fabric" {
		t.Errorf("cluster.cluster_name = %v, want the existing Fabric cluster", cl["cluster_name"])
	}
	// No cluster shape (no tofu): only the name is carried.
	if _, hasShape := cl["node_min_size"]; hasShape {
		t.Errorf("namespace snapshot must not carry a cluster shape: %v", cl)
	}
	// No apps repo → no repositories block (isolation-only).
	snap2 := buildNamespaceSnapshot(namespaceTenantParams{project: "shop", env: "prod", provider: "aws", fabricClust: "eks-fabric"}, "ns")
	if _, ok := snap2["repositories"]; ok {
		t.Errorf("empty apps repo must omit repositories: %v", snap2["repositories"])
	}
}

func TestFindNamespaceApp(t *testing.T) {
	list := []byte(`{"items":[
	  {"metadata":{"name":"other"},"spec":{"project":"apps","destination":{"server":"https://kubernetes.default.svc","namespace":"elsewhere"}}},
	  {"metadata":{"name":"app-shop-ns"},"spec":{"project":"tenant-shop-ns","destination":{"server":"https://kubernetes.default.svc","namespace":"target-ns"}}}
	]}`)
	app, err := findNamespaceApp(list, "target-ns")
	if err != nil {
		t.Fatalf("expected match, got %v", err)
	}
	if app.Metadata.Name != "app-shop-ns" || app.Spec.Project != "tenant-shop-ns" {
		t.Errorf("found wrong app: %+v", app)
	}

	// Fail closed: an app routed to the ns but pinned to the wide-open infra project is rejected.
	bad := []byte(`{"items":[{"metadata":{"name":"escape"},"spec":{"project":"infra","destination":{"server":"https://kubernetes.default.svc","namespace":"target-ns"}}}]}`)
	if _, err := findNamespaceApp(bad, "target-ns"); err == nil {
		t.Error("expected rejection of an app pinned to the wide-open infra project")
	}

	// No app targeting the namespace → error (app not delivered).
	if _, err := findNamespaceApp(list, "missing-ns"); err == nil {
		t.Error("expected error when no app targets the namespace")
	}
}

func TestNamespaceClusterUnchangedAndArgoReinstall(t *testing.T) {
	if err := namespaceClusterUnchanged("eks-fabric", "eks-fabric"); err != nil {
		t.Errorf("same cluster should pass: %v", err)
	}
	if err := namespaceClusterUnchanged("eks-fabric", "eks-NEW"); err == nil {
		t.Error("a different cluster (new cluster provisioned) must fail")
	}
	if err := namespaceClusterUnchanged("eks-fabric", ""); err == nil {
		t.Error("empty cluster must fail")
	}

	if err := argocdNotReinstalled("2026-07-21T00:00:00Z", "2026-07-21T00:00:00Z"); err != nil {
		t.Errorf("unchanged timestamp should pass: %v", err)
	}
	if err := argocdNotReinstalled("2026-07-21T00:00:00Z", "2026-07-21T01:00:00Z"); err == nil {
		t.Error("changed creationTimestamp (reinstall) must fail")
	}
}
