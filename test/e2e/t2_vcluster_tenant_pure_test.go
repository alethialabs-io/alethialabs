// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure unit tests for the vcluster-placement scenario helpers (#1308) — no cloud, no Postgres, no
// build tag, so they run in ordinary `go test`.
package e2e

import "testing"

func TestVClusterTenantSlug(t *testing.T) {
	cases := map[string]string{
		"production":  "e2e-vc-production",
		"Staging Env": "e2e-vc-staging-env",
		"":            "e2e-vc-env",
	}
	for in, want := range cases {
		if got := vclusterTenantSlug(in); got != want {
			t.Errorf("vclusterTenantSlug(%q) = %q, want %q", in, got, want)
		}
	}
	// Bounded so the derived host namespace `vcluster-<name>` (prefix adds 9) stays within the 63-char
	// k8s namespace limit.
	long := vclusterTenantSlug("a-very-long-environment-name-that-blows-well-past-the-fifty-four-character-limit")
	if len(long) > 54 {
		t.Errorf("slug %q exceeded 54 chars (%d)", long, len(long))
	}
	if len("vcluster-"+long) > 63 {
		t.Errorf("derived host namespace vcluster-%s exceeds the 63-char k8s limit", long)
	}
}

func TestBuildVClusterSnapshot(t *testing.T) {
	p := vclusterTenantParams{project: "shop", env: "prod", provider: "aws", region: "us-east-1", fabricClust: "eks-fabric", appsRepo: "https://github.com/acme/manifests"}
	snap := buildVClusterSnapshot(p, "e2e-vc-prod")
	if snap["placement_mode"] != "vcluster" {
		t.Errorf("placement_mode = %v", snap["placement_mode"])
	}
	if snap["namespace"] != "e2e-vc-prod" {
		t.Errorf("namespace = %v", snap["namespace"])
	}
	cl, _ := snap["cluster"].(map[string]any)
	if cl["cluster_name"] != "eks-fabric" {
		t.Errorf("cluster.cluster_name = %v, want the existing Fabric cluster", cl["cluster_name"])
	}
	// No cluster shape (no tofu): only the name is carried.
	if _, hasShape := cl["node_min_size"]; hasShape {
		t.Errorf("vcluster snapshot must not carry a cluster shape: %v", cl)
	}
	// No apps repo → no repositories block (vcluster + registration only).
	snap2 := buildVClusterSnapshot(vclusterTenantParams{project: "shop", env: "prod", provider: "aws", fabricClust: "eks-fabric"}, "e2e-vc-prod")
	if _, ok := snap2["repositories"]; ok {
		t.Errorf("empty apps repo must omit repositories: %v", snap2["repositories"])
	}
}

func TestFindVClusterApp(t *testing.T) {
	list := []byte(`{"items":[
	  {"metadata":{"name":"other"},"spec":{"project":"apps","destination":{"name":"elsewhere"}}},
	  {"metadata":{"name":"vc-app-shop"},"spec":{"project":"vc-shop-e2e-vc-prod","destination":{"name":"e2e-vc-prod","namespace":"e2e-vc-prod"}}}
	]}`)
	app, err := findVClusterApp(list, "e2e-vc-prod")
	if err != nil {
		t.Fatalf("expected match, got %v", err)
	}
	if app.Metadata.Name != "vc-app-shop" || app.Spec.Project != "vc-shop-e2e-vc-prod" {
		t.Errorf("found wrong app: %+v", app)
	}

	// Fail closed: an app routed to the vcluster name but with a host destination.server is rejected
	// (a vcluster placement is name-based, not server-based).
	hostRouted := []byte(`{"items":[{"metadata":{"name":"escape"},"spec":{"project":"vc-shop","destination":{"name":"e2e-vc-prod","server":"https://kubernetes.default.svc"}}}]}`)
	if _, err := findVClusterApp(hostRouted, "e2e-vc-prod"); err == nil {
		t.Error("expected rejection of a vcluster app that sets a host destination.server")
	}

	// Fail closed: an app pinned to the wide-open infra project is rejected.
	bad := []byte(`{"items":[{"metadata":{"name":"escape"},"spec":{"project":"infra","destination":{"name":"e2e-vc-prod"}}}]}`)
	if _, err := findVClusterApp(bad, "e2e-vc-prod"); err == nil {
		t.Error("expected rejection of an app pinned to the wide-open infra project")
	}

	// No app targeting the vcluster → error (app not delivered).
	if _, err := findVClusterApp(list, "missing-vc"); err == nil {
		t.Error("expected error when no app targets the vcluster")
	}
}

func TestFindVClusterClusterSecret(t *testing.T) {
	present := []byte(`{"items":[
	  {"metadata":{"name":"other","labels":{"argocd.argoproj.io/secret-type":"repository"}}},
	  {"metadata":{"name":"e2e-vc-prod","labels":{"argocd.argoproj.io/secret-type":"cluster","alethia.io/vcluster-cluster":"true"}}}
	]}`)
	if err := findVClusterClusterSecret(present, "e2e-vc-prod"); err != nil {
		t.Errorf("expected the cluster Secret to be found: %v", err)
	}

	// Present but missing the secret-type=cluster label → rejected.
	wrongLabel := []byte(`{"items":[{"metadata":{"name":"e2e-vc-prod","labels":{"argocd.argoproj.io/secret-type":"repository"}}}]}`)
	if err := findVClusterClusterSecret(wrongLabel, "e2e-vc-prod"); err == nil {
		t.Error("expected rejection of a Secret without the secret-type=cluster label")
	}

	// Absent → rejected (vcluster not registered).
	if err := findVClusterClusterSecret(present, "missing-vc"); err == nil {
		t.Error("expected error when no cluster Secret is registered for the vcluster")
	}
}
