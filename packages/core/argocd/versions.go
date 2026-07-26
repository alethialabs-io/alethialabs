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
//
// SSOT for the chart↔Kubernetes coupling: packages/core/compat/matrix.json → components[argocd].
// The compat couplings drift test (packages/core/compat/couplings_drift_test.go) fails if
// DefaultArgoChartVersion is not a recorded matrix release or is incompatible with the templates'
// default Kubernetes minor (#1214).
const (
	// DefaultArgoHelmRepo is the argo-helm chart repository.
	DefaultArgoHelmRepo = "https://argoproj.github.io/argo-helm"
	// DefaultArgoChartVersion is the pinned argo-cd chart version. 8.6.4 bundles ArgoCD v3.1.8, whose
	// gitops-engine carries the Kubernetes 1.33+ OpenAPI schema (Deployment/ReplicaSet
	// `.status.terminatingReplicas`, KEP-3973). The prior 7.1.3 (v2.11) predated that field, so its
	// structured-merge-diff failed to build a typed value for ANY live Deployment on a 1.33+ cluster
	// → `sync=Unknown` and GitOps never converged. All project templates default to K8s 1.35, so this
	// affected every cloud (#1165).
	DefaultArgoChartVersion = "8.6.4"
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
