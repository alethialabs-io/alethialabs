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

// TestResolvedArgoInstallTimeout covers the validation the other two resolvers deliberately lack:
// helm rejects a malformed --timeout and exits at once, so passing a typo through would surface as
// an instant "ArgoCD install failed" and read as a broken chart rather than a bad env var.
func TestResolvedArgoInstallTimeout(t *testing.T) {
	if got := ResolvedArgoInstallTimeout(); got != DefaultArgoInstallTimeout {
		t.Errorf("default = %q, want %q", got, DefaultArgoInstallTimeout)
	}
	t.Setenv(ArgoInstallTimeoutEnv, "  20m  ")
	if got := ResolvedArgoInstallTimeout(); got != "20m" {
		t.Errorf("override = %q, want 20m", got)
	}
	for _, bad := range []string{"", "   ", "banana", "5", "-1m", "0", "0s"} {
		t.Setenv(ArgoInstallTimeoutEnv, bad)
		if got := ResolvedArgoInstallTimeout(); got != DefaultArgoInstallTimeout {
			t.Errorf("override %q = %q, want the default %q", bad, got, DefaultArgoInstallTimeout)
		}
	}
}
