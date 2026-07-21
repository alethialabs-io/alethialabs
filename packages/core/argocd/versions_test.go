// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import "testing"

func TestResolvedArgoHelmRepo(t *testing.T) {
	if got := ResolvedArgoHelmRepo(); got != DefaultArgoHelmRepo {
		t.Errorf("default = %q, want %q", got, DefaultArgoHelmRepo)
	}
	t.Setenv(ArgoHelmRepoEnv, "  https://charts.example.com/argo  ")
	if got := ResolvedArgoHelmRepo(); got != "https://charts.example.com/argo" {
		t.Errorf("override (trimmed) = %q", got)
	}
	t.Setenv(ArgoHelmRepoEnv, "   ")
	if got := ResolvedArgoHelmRepo(); got != DefaultArgoHelmRepo {
		t.Errorf("blank override should fall back to default, got %q", got)
	}
}

func TestResolvedArgoChartVersion(t *testing.T) {
	if got := ResolvedArgoChartVersion(); got != DefaultArgoChartVersion {
		t.Errorf("default = %q, want %q", got, DefaultArgoChartVersion)
	}
	t.Setenv(ArgoChartVersionEnv, "7.2.0")
	if got := ResolvedArgoChartVersion(); got != "7.2.0" {
		t.Errorf("override = %q, want 7.2.0", got)
	}
}
