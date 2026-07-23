// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestBuildVClusterSpec(t *testing.T) {
	vc := &types.ProjectConfig{
		ProjectName:   "acme",
		Namespace:     "team-web",
		PlacementMode: types.PlacementModeVcluster,
	}
	spec, err := BuildVClusterSpec(vc, "")
	if err != nil {
		t.Fatalf("BuildVClusterSpec: %v", err)
	}
	if spec.Name != "team-web" {
		t.Errorf("Name = %q, want team-web", spec.Name)
	}
	if spec.HostNamespace != "vcluster-team-web" {
		t.Errorf("HostNamespace = %q, want vcluster-team-web", spec.HostNamespace)
	}
	if spec.ServiceAccount != "vcluster-argocd-team-web" {
		t.Errorf("ServiceAccount = %q", spec.ServiceAccount)
	}
	if spec.KubeconfigSecret != "vcluster-kubeconfig-team-web" {
		t.Errorf("KubeconfigSecret = %q", spec.KubeconfigSecret)
	}
	// Empty argoNamespace defaults to "argocd".
	if spec.KubeconfigNamespace != "argocd" {
		t.Errorf("KubeconfigNamespace = %q, want argocd (default)", spec.KubeconfigNamespace)
	}
	// The spec must already be valid (BuildVClusterSpec validates before returning).
	if err := spec.Validate(); err != nil {
		t.Errorf("built spec is invalid: %v", err)
	}
}

func TestBuildVClusterSpecOverrideArgoNamespace(t *testing.T) {
	vc := &types.ProjectConfig{Namespace: "prod"}
	spec, err := BuildVClusterSpec(vc, "gitops")
	if err != nil {
		t.Fatalf("BuildVClusterSpec: %v", err)
	}
	if spec.KubeconfigNamespace != "gitops" {
		t.Errorf("KubeconfigNamespace = %q, want gitops", spec.KubeconfigNamespace)
	}
}

func TestBuildVClusterSpecFailsClosed(t *testing.T) {
	if _, err := BuildVClusterSpec(nil, "argocd"); err == nil {
		t.Error("nil config: expected error, got nil")
	}
	if _, err := BuildVClusterSpec(&types.ProjectConfig{Namespace: ""}, "argocd"); err == nil {
		t.Error("empty namespace: expected error, got nil")
	}
	// A namespace that isn't a valid DNS-1123 label must fail closed (it would flow into helm/kubectl).
	if _, err := BuildVClusterSpec(&types.ProjectConfig{Namespace: "Bad NS"}, "argocd"); err == nil {
		t.Error("invalid namespace: expected validation error, got nil")
	}
	// A namespace long enough that a derived, prefixed name blows past the 63-char DNS-1123 limit must
	// fail closed rather than produce an unusable resource name.
	long := strings.Repeat("a", 60)
	if _, err := BuildVClusterSpec(&types.ProjectConfig{Namespace: long}, "argocd"); err == nil {
		t.Error("over-long derived name: expected validation error, got nil")
	}
}
