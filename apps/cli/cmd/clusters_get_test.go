// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func strptr(s string) *string { return &s }

// TestFindCluster covers exact matches (project/cluster/id), the substring fallback,
// case-insensitivity, and the no-match paths (empty query, no candidates).
func TestFindCluster(t *testing.T) {
	clusters := []api.ClusterSummary{
		{ID: "clu_1", ProjectName: "web", ClusterName: "web-eks"},
		{ID: "clu_2", ProjectName: "payments-api", ClusterName: "pay-eks"},
	}

	if c := findCluster(clusters, "WEB"); c == nil || c.ID != "clu_1" {
		t.Fatalf("exact project-name match (case-insensitive) failed: %+v", c)
	}
	if c := findCluster(clusters, "pay-eks"); c == nil || c.ID != "clu_2" {
		t.Fatalf("exact cluster-name match failed: %+v", c)
	}
	if c := findCluster(clusters, "clu_1"); c == nil || c.ID != "clu_1" {
		t.Fatalf("exact id match failed: %+v", c)
	}
	if c := findCluster(clusters, "  payments  "); c == nil || c.ID != "clu_2" {
		t.Fatalf("substring fallback (trimmed) failed: %+v", c)
	}
	if c := findCluster(clusters, "nope"); c != nil {
		t.Fatalf("no-match should be nil, got %+v", c)
	}
	if c := findCluster(clusters, ""); c != nil {
		t.Fatalf("empty query must not substring-match everything, got %+v", c)
	}
}

// TestClusterFieldRows covers the present-only projection: the full field set plus the
// ArgoCD block (URL vs port-forward) and the minimal un-provisioned case.
func TestClusterFieldRows(t *testing.T) {
	cost := 96.0
	full := &api.ClusterSummary{
		ProjectName: "web", Environment: "prod", ClusterName: "web-eks",
		ClusterVersion: "1.30", Status: "ACTIVE", StatusMessage: "rolling",
		Region: "eu-central-1", NodeMinSize: 1, NodeDesiredSize: 3, NodeMaxSize: 5,
		EstimatedMonthlyCost: &cost, ArgocdURL: "https://argo.example",
	}
	rows := clusterFieldRows(full, nil)
	got := map[string]string{}
	for _, r := range rows {
		got[r[0]] = r[1]
	}
	for _, key := range []string{"Status", "Message", "Cluster", "Version", "Region", "Nodes", "Est. cost", "ArgoCD", "ArgoCD admin"} {
		if _, ok := got[key]; !ok {
			t.Errorf("expected field %q in rows, got %+v", key, got)
		}
	}
	if got["ArgoCD"] != "https://argo.example" {
		t.Errorf("ArgoCD row should be the managed URL, got %q", got["ArgoCD"])
	}
	if !strings.Contains(got["Est. cost"], "$96/mo") {
		t.Errorf("cost row = %q", got["Est. cost"])
	}

	// Un-provisioned (no cluster name): no ArgoCD block, no optional fields.
	bare := clusterFieldRows(&api.ClusterSummary{ProjectName: "x", Status: "QUEUED"}, nil)
	for _, r := range bare {
		if r[0] == "ArgoCD" || r[0] == "ArgoCD admin" || r[0] == "Message" || r[0] == "Cluster" {
			t.Errorf("un-provisioned cluster should not emit %q", r[0])
		}
	}

	// Provisioned but no managed ingress ⇒ port-forward note.
	pf := clusterFieldRows(&api.ClusterSummary{ProjectName: "y", ClusterName: "y-eks", Status: "ACTIVE"}, nil)
	var argocd string
	for _, r := range pf {
		if r[0] == "ArgoCD" {
			argocd = r[1]
		}
	}
	if !strings.Contains(argocd, "port-forward") {
		t.Errorf("no-ingress ArgoCD row should mention port-forward, got %q", argocd)
	}
}

// TestGitopsRows covers each posture branch: failed step, unknown (no snapshot), the
// synced/healthy summary with revision truncation, and the apps-repo row.
func TestGitopsRows(t *testing.T) {
	// Failure banner with message.
	failed := gitopsRows(&api.ClusterGitops{
		LastDeployFailed: true, FailedStep: strptr("apply"), FailureMessage: strptr("quota"),
	})
	if !strings.Contains(failed[0][1], "failed at apply") || !strings.Contains(failed[0][1], "quota") {
		t.Errorf("failure line = %q", failed[0][1])
	}

	// Unknown — no trustworthy snapshot.
	unknown := gitopsRows(&api.ClusterGitops{StatusAvailable: false})
	if !strings.Contains(unknown[0][1], "unknown") {
		t.Errorf("unknown line = %q", unknown[0][1])
	}

	// Healthy summary with long revision truncated to 7 chars + apps repo row.
	ok := gitopsRows(&api.ClusterGitops{
		StatusAvailable: true, Total: 4, Synced: 4, Healthy: 3,
		Revision: strptr("abcdef1234567890"), AppsRepo: strptr("github.com/acme/apps"),
	})
	if !strings.Contains(ok[0][1], "4/4 synced") || !strings.Contains(ok[0][1], "3/4 healthy") {
		t.Errorf("summary line = %q", ok[0][1])
	}
	if !strings.Contains(ok[0][1], "rev abcdef1") || strings.Contains(ok[0][1], "abcdef12") {
		t.Errorf("revision should be truncated to 7 chars, got %q", ok[0][1])
	}
	if len(ok) < 2 || ok[1][0] != "Apps repo" || ok[1][1] != "github.com/acme/apps" {
		t.Errorf("apps-repo row missing/wrong: %+v", ok)
	}
}

// TestRenderCluster covers the three output formats and the with/without-gitops record shape.
func TestRenderCluster(t *testing.T) {
	c := &api.ClusterSummary{ProjectName: "web", Environment: "prod", ClusterName: "web-eks", Status: "ACTIVE"}
	g := &api.ClusterGitops{StatusAvailable: true, Total: 1, Synced: 1, Healthy: 1}

	for _, format := range []string{"table", "json", "csv"} {
		var buf bytes.Buffer
		if err := renderCluster(&buf, format, c, g); err != nil {
			t.Fatalf("renderCluster(%s) error: %v", format, err)
		}
		if buf.Len() == 0 {
			t.Errorf("renderCluster(%s) wrote nothing", format)
		}
	}

	// Without gitops the plain cluster is still rendered.
	var buf bytes.Buffer
	if err := renderCluster(&buf, "json", c, nil); err != nil {
		t.Fatalf("renderCluster(json, no gitops) error: %v", err)
	}
	if !strings.Contains(buf.String(), "web-eks") {
		t.Errorf("json output should contain the cluster name, got %q", buf.String())
	}
}
