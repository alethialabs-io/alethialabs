// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"strings"
	"testing"
)

func mustContain(t *testing.T, s, sub string) {
	t.Helper()
	if !strings.Contains(s, sub) {
		t.Errorf("render missing %q", sub)
	}
}

func TestRenderHelmRepoRefreshers_Empty(t *testing.T) {
	y, err := RenderHelmRepoRefreshers(nil, "arn:x", "img:1")
	if err != nil || y != "" {
		t.Fatalf("empty targets → empty render: y=%q err=%v", y, err)
	}
}

func TestRenderHelmRepoRefreshers_FailClosed(t *testing.T) {
	priv := []HelmRepoRefresher{{SecretName: "repo-helm-abc", RepoURL: "oci://h", Region: "us-east-1", TargetRoleArn: "arn:r"}}
	// Missing IRSA / runner image → fail-closed error.
	if _, err := RenderHelmRepoRefreshers(priv, "", "img"); err == nil {
		t.Error("missing IRSA must error")
	}
	if _, err := RenderHelmRepoRefreshers(priv, "arn", ""); err == nil {
		t.Error("missing runner image must error")
	}
	// A private target missing its region/role → error (never a half-wired refresher).
	if _, err := RenderHelmRepoRefreshers([]HelmRepoRefresher{{SecretName: "repo-helm-abc", RepoURL: "oci://h"}}, "arn", "img"); err == nil {
		t.Error("private target without region/role must error")
	}
}

func TestRenderHelmRepoRefreshers_Private(t *testing.T) {
	y, err := RenderHelmRepoRefreshers([]HelmRepoRefresher{{
		SecretName:    "repo-helm-abc123",
		RepoURL:       "oci://111.dkr.ecr.us-east-1.amazonaws.com",
		Region:        "us-east-1",
		TargetRoleArn: "arn:aws:iam::111:role/pull",
	}}, "arn:aws:iam::999:role/helm-pull", "ghcr.io/runner:test")
	if err != nil {
		t.Fatal(err)
	}
	// Shared KSA, IRSA-annotated, in the argocd namespace.
	mustContain(t, y, "kind: ServiceAccount")
	mustContain(t, y, "name: alethia-helm-repo-pull")
	mustContain(t, y, "namespace: argocd")
	mustContain(t, y, `eks.amazonaws.com/role-arn: "arn:aws:iam::999:role/helm-pull"`)
	// Placeholder repo-cred Secret ArgoCD recognises (OCI repo-creds).
	mustContain(t, y, "argocd.argoproj.io/secret-type: repo-creds")
	mustContain(t, y, "name: repo-helm-abc123")
	// Name-scoped Role: get+patch on ONLY that Secret — the tightest RBAC.
	mustContain(t, y, `resourceNames: ["repo-helm-abc123"]`)
	mustContain(t, y, `verbs: ["get", "patch"]`)
	// Deployment runs helm-repo-token with the private-ECR args.
	mustContain(t, y, "- helm-repo-token")
	mustContain(t, y, "- --target-role-arn")
	mustContain(t, y, "- --region")
	// RBAC must NOT be broad, and a private target carries no --public.
	for _, bad := range []string{`"create"`, `"delete"`, `"list"`, `"watch"`, `"*"`} {
		if strings.Contains(y, bad) {
			t.Errorf("refresher RBAC too broad: contains %q", bad)
		}
	}
	if strings.Contains(y, "--public") {
		t.Error("a private target must not carry --public")
	}
}

func TestRenderHelmRepoRefreshers_Public(t *testing.T) {
	y, err := RenderHelmRepoRefreshers([]HelmRepoRefresher{{
		SecretName: "repo-helm-pub", RepoURL: "oci://public.ecr.aws", Public: true,
	}}, "arn:aws:iam::999:role/helm-pull", "img:1")
	if err != nil {
		t.Fatal(err)
	}
	mustContain(t, y, "- --public")
	if strings.Contains(y, "--target-role-arn") {
		t.Error("a public target must not carry --target-role-arn")
	}
}

func TestRenderHelmRepoRefreshers_MultiSharesKSA(t *testing.T) {
	y, err := RenderHelmRepoRefreshers([]HelmRepoRefresher{
		{SecretName: "repo-helm-a", RepoURL: "oci://a", Region: "us-east-1", TargetRoleArn: "arn:a"},
		{SecretName: "repo-helm-b", RepoURL: "oci://b", Region: "eu-west-1", TargetRoleArn: "arn:b"},
	}, "arn:aws:iam::999:role/helm-pull", "img:1")
	if err != nil {
		t.Fatal(err)
	}
	// One shared KSA across the two repos (the IRSA annotation appears exactly once — on that KSA), but a
	// distinct per-repo Deployment.
	if n := strings.Count(y, "eks.amazonaws.com/role-arn"); n != 1 {
		t.Errorf("want exactly 1 IRSA-annotated shared KSA, got %d", n)
	}
	if n := strings.Count(y, "kind: Deployment"); n != 2 {
		t.Errorf("want 2 per-repo Deployments, got %d", n)
	}
	mustContain(t, y, "name: repo-helm-a-refresher")
	mustContain(t, y, "name: repo-helm-b-refresher")
}
