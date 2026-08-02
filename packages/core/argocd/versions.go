// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"strings"
	"time"
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

	// DefaultArgoInstallTimeout is the `helm --wait` budget for the argo-cd chart. The previous 5m
	// was too tight on the T2 green-floor shape: ONE t3.large (2 BURSTABLE vCPU / 8 GiB, 20 GB disk,
	// cold image cache) has to schedule ~7 pods, pull the argocd/dex/redis images and pass every
	// readiness probe, and it timed out three nights running with `context deadline exceeded` (#1734).
	//
	// The ceiling is NOT the 80m go-test timeout — it is the T2 harness's per-job WaitTerminal
	// (aws: 50m, test/e2e/t2_providers.go). The failing run reached its terminal status in 24m37s
	// WITH the full 5m wait consumed, so the rest of the deploy spine costs ~20m; on the success
	// path the post-ArgoCD work (infra-services + addonConvergeTimeout, itself 10m) still has to
	// fit. 10m doubles the budget while leaving that headroom intact. Raise it per-run with the env
	// override rather than by editing this constant.
	DefaultArgoInstallTimeout = "10m"
	// ArgoInstallTimeoutEnv overrides DefaultArgoInstallTimeout (a Go duration, e.g. "20m").
	ArgoInstallTimeoutEnv = "ALETHIA_ARGOCD_INSTALL_TIMEOUT"
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

// ResolvedArgoInstallTimeout returns ALETHIA_ARGOCD_INSTALL_TIMEOUT when it parses as a POSITIVE Go
// duration, else DefaultArgoInstallTimeout.
//
// Unlike the two resolvers above this VALIDATES rather than passing the value through: helm rejects
// a malformed --timeout and exits immediately, so a typo'd override would surface as an instant
// "ArgoCD install failed" and read as a broken chart rather than a bad env var — the same class of
// misdiagnosis this whole change exists to remove.
func ResolvedArgoInstallTimeout() string {
	v := strings.TrimSpace(os.Getenv(ArgoInstallTimeoutEnv))
	if v == "" {
		return DefaultArgoInstallTimeout
	}
	if d, err := time.ParseDuration(v); err != nil || d <= 0 {
		return DefaultArgoInstallTimeout
	}
	return v
}
