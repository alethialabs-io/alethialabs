// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"testing"
	"time"
)

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

// The DEFAULT is the value that actually ships, and nothing above validates it: every assertion in
// TestResolvedArgoInstallTimeout compares the resolver's answer TO THE CONSTANT, so a typo'd
// constant satisfies all of them and the suite stays green. It would then fail on a real cloud, at
// spend, as an instant "ArgoCD install failed" — precisely the misdiagnosis the resolver's own
// validation exists to prevent, arriving through the one input the validation never sees.
//
// The floor is not a style preference. 33080748841 measured ~3m30s of image-pull QUEUE before the
// application-controller began pulling at all, so a default under 5m cannot cover a cold cluster
// even when nothing is wrong, and would re-create #1734.
func TestDefaultArgoInstallTimeoutIsUsable(t *testing.T) {
	d, err := time.ParseDuration(DefaultArgoInstallTimeout)
	if err != nil {
		t.Fatalf("DefaultArgoInstallTimeout %q does not parse as a Go duration — helm would reject it and the failure would read as a broken chart: %v", DefaultArgoInstallTimeout, err)
	}
	if d < 5*time.Minute {
		t.Errorf("DefaultArgoInstallTimeout = %v, which cannot cover a cold cluster's image-pull queue (measured ~3m30s before the application-controller starts pulling)", d)
	}
}
