// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"strings"
)

// The ArgoCD Helm chart repo + version the installer uses. Kept config-driven (env override with the
// current literals as defaults) so a runner can pin/bump them without a code change and so they don't
// silently drift from what CI/templates expect (#951). Mirrors infracost.ResolvedInfracostVersion.
const (
	// DefaultArgoHelmRepo is the argo-helm chart repository.
	DefaultArgoHelmRepo = "https://argoproj.github.io/argo-helm"
	// DefaultArgoChartVersion is the pinned argo-cd chart version.
	DefaultArgoChartVersion = "7.1.3"
	// ArgoHelmRepoEnv overrides DefaultArgoHelmRepo.
	ArgoHelmRepoEnv = "ALETHIA_ARGOCD_HELM_REPO"
	// ArgoChartVersionEnv overrides DefaultArgoChartVersion.
	ArgoChartVersionEnv = "ALETHIA_ARGOCD_CHART_VERSION"
)

// ResolvedArgoHelmRepo returns ALETHIA_ARGOCD_HELM_REPO when set, else DefaultArgoHelmRepo.
func ResolvedArgoHelmRepo() string {
	if v := strings.TrimSpace(os.Getenv(ArgoHelmRepoEnv)); v != "" {
		return v
	}
	return DefaultArgoHelmRepo
}

// ResolvedArgoChartVersion returns ALETHIA_ARGOCD_CHART_VERSION when set, else DefaultArgoChartVersion.
func ResolvedArgoChartVersion() string {
	if v := strings.TrimSpace(os.Getenv(ArgoChartVersionEnv)); v != "" {
		return v
	}
	return DefaultArgoChartVersion
}
