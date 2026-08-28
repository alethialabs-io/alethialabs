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
	// DefaultArgoChartVersion is the pinned argo-cd chart version. 9.5.11 bundles ArgoCD v3.3.9.
	//
	// ── Why this is 9.5.11 and not 8.6.4, and not 10.4.1 either ──
	//
	// The previous pin, 8.6.4 → v3.1.8 (2025-09-30), kept every add-on StatefulSet that owns
	// `volumeClaimTemplates` permanently OutOfSync while `argocd app diff` printed nothing (#2717).
	// The mechanism is settled from argo-cd's own source: every add-on Application sets
	// `ServerSideApply=true` (addons.go), so the CONTROLLER compares with structured-merge diff
	// while the CLI runs the plain client-side diff — two different algorithms, not a contradiction.
	// Structured-merge diff on v3.1.8 mishandles the fields the API server materialises into an
	// embedded ObjectMeta, which is why the correlation was 6 of 6 StatefulSets WITH
	// volumeClaimTemplates OutOfSync and 0 of 2 without, on hetzner/addons run 33149451505.
	//
	// Three upstream defects had to be cleared, each verified against the actual git trees (the
	// GitHub `compare` API for ancestry, and the tree itself for the dependency pins) rather than
	// read off release notes or dates:
	//
	//	argo-cd#24844   "structured merge diff fix for null metadata field" — the fix for the class
	//	                above. It is nothing but a dependency bump, so ancestry alone would not be
	//	                proof: merge commit 96038ba2 is an ancestor of v3.3.0 and v3.3.9 and NOT of
	//	                v3.1.8, v3.1.16 or v3.2.0, AND `gitops-engine/go.mod` at v3.3.9 pins
	//	                sigs.k8s.io/structured-merge-diff/v6 v6.3.1-0.20251003215857-446d8398e19c,
	//	                whose commit IS structured-merge-diff#306's merge commit 446d8398e19c.
	//	argo-cd#24423   ServerSideDiff + `ignoreDifferences` → empty diff, resource still OutOfSync.
	//	                Still OPEN as a tracker, but a maintainer closed it on substance ("already
	//	                fixed in #17362"), and #17362's fix is gitops-engine#747 (`skipFullNormalize`).
	//	                We carry two ignoreDifferences entries AND `RespectIgnoreDifferences=true`, so
	//	                this one lands on us. From v3.3.0 argo-cd vendors gitops-engine in-tree
	//	                (`replace … => ./gitops-engine`), and v3.3.9's gitops-engine/pkg/diff/diff.go
	//	                carries `WithSkipFullNormalize(true)`. v3.1.8's external gitops-engine pin
	//	                e48120133eec does NOT have it — the tree was read, not the pin's date.
	//	argo-cd#25184   a Server-Side Diff regression on `spec.template.metadata.creationTimestamp`
	//	                INTRODUCED at v3.2.0 — the same symptom shape we are trying to leave. CLOSED
	//	                by argo-cd#25210, merge commit 728f2e74, an ancestor of v3.3.0/v3.3.9 and NOT
	//	                of v3.2.0. So the fix is in and the regression is not.
	//
	// v3.2.1 also clears all three on paper (its gitops-engine pin 13d5172d IS #25184's cherry-pick,
	// and Go's MVS already selects the fixed structured-merge-diff from the root go.mod). It is
	// deliberately NOT taken: argo-cd supports the last three minors (SECURITY.md), which with v3.5
	// current means 3.3/3.4/3.5 — v3.2 is EOL, and replacing one stale pin with another is the
	// mistake this change exists to undo. v3.3 is therefore the lowest SUPPORTED minor that clears
	// all three, and 9.5.11 is the last argo-helm release on it (9.5.12 moves to v3.4.1).
	//
	// The K8s 1.33 floor from #1165 is unchanged and still recorded in the matrix: v3.1.8's
	// gitops-engine first carried the 1.33+ OpenAPI schema (Deployment/ReplicaSet
	// `.status.terminatingReplicas`, KEP-3973); the pre-#1165 7.1.3 (v2.11) predated it, so its
	// structured-merge-diff could not build a typed value for ANY live Deployment on a 1.33+ cluster
	// → `sync=Unknown`. All project templates default to K8s 1.35, so that affected every cloud.
	// v3.3.9 is strictly newer, and the chart still declares `kubeVersion: >=1.25.0-0`.
	//
	// SSOT for the coupling is packages/core/compat/matrix.json → components[argocd]; the couplings
	// drift test refuses a pin that is not a recorded release there.
	//
	// This is expected to fix the OutOfSync class. It is NOT proven until an addons run says so —
	// the mechanism and the ancestry are established, the outcome on a live cluster is not.
	DefaultArgoChartVersion = "9.5.11"
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
	// fit. Raise it per-run with the env override rather than by editing this constant.
	//
	// ── 10m → 15m (#3030), and the measurement that moved it. SUPERSEDED — see 15m → 20m below. ──
	//
	// 10m was not enough on GKE. The scheduled floor run 33080748841 failed with
	// `Error: context deadline exceeded`, and the namespace dump taken before teardown says exactly
	// why — it is a PULL QUEUE, not a broken chart:
	//
	//	argo-cd-argocd-application-controller-0   0/1  ContainerCreating  10m
	//	(every other argocd pod: 1/1 Running)
	//
	//	events:
	//	  9m23s  Pulling  repo-server/dex/applicationset/server   quay.io/argoproj/argocd:v3.1.8
	//	  6m35s  Pulling  application-controller-0                quay.io/argoproj/argocd:v3.1.8
	//	  5m58s  Pulled   redis  …in 36.033s (3m25.557s INCLUDING WAITING)
	//
	// Six pods pull the same multi-hundred-MB image onto a cold cluster at once. Redis names the
	// contention outright: 36s of pull behind 3m25s of queue. The application-controller did not
	// even BEGIN pulling until ~3m30s after it was scheduled, and its node was flapping at the same
	// time (`TaintManagerEviction: Cancelling deletion of Pod`, gke-metadata-server 0/1 with a
	// restart, metrics-server 0/1 with two). So the deadline expired on a pull that was still
	// making progress — the same shape as the 5m → 10m move, one cloud further along.
	//
	// 15m is the smallest step that covers the observed cost (≈3m30s of queue + a pull that is
	// slow-but-working) and it stays inside gcp's 50m WaitTerminal with the ~20m spine and the 10m
	// add-on convergence still fitting.
	//
	// ── 15m → 20m, and why the deadline alone was never going to be the fix. ──
	//
	// 15m failed on gcp floor run 33156252646, and the namespace dump names TWO independent causes.
	// Only ONE of them is a deadline; the other is fixed alongside this, in InstallProbeValues.
	//
	// The node is an `e2-small` — 2 SHARED vCPU, 2 GiB — on a 20 GB pd-standard disk, and FIVE of
	// the seven argocd pods landed on the same one. What the kubelet recorded there:
	//
	//	Pulled  redis  …in 6m29.827s (11m48.225s including waiting). Image size: 16855420 bytes
	//	Pulled  dex init (argocd)     …in 4m17.749s (5m16.349s including waiting)
	//	Pulled  server / repo-server  …in ~6s      (5m19s   including waiting)
	//	7m57s  Normal  Killing  argocd-server       Container server failed liveness probe, will be restarted
	//	   6s  Normal  Killing  argocd-repo-server  Container repo-server failed liveness probe, will be restarted
	//
	//	at the 15m deadline:
	//	  argocd-dex-server    0/1  PodInitializing  15m          ← still pulling its SECOND image
	//	  argocd-repo-server   1/1  Running          2 restarts (117s ago)
	//	  argocd-server        1/1  Running          1 restart  (7m51s ago)
	//
	// 16.9 MB of redis took 6m29s of PULL — ~43 KB/s. That is the number that sets the scale here,
	// and it is not the same shape as 33080748841's queue: this disk is genuinely saturated.
	//
	// Two things follow, and BOTH had to change:
	//
	//  1. The restarts. repo-server's second liveness kill landed SIX SECONDS before the deadline,
	//     which no deadline can survive — a kill resets the pod's readiness, so a longer wait just
	//     buys a thrashing install more time to thrash. That half is InstallProbeValues.
	//  2. The pulls. dex was NOT probe-killed — it has no probes (the chart disables them) and it
	//     was in PodInitializing, pulling ghcr.io/dexidp/dex, which it only STARTED at ~t+10m37s.
	//     Nothing about probe tuning helps that. That half is this number.
	//
	// Why 20m and not "round it up". With the kills removed, server and repo-server become Ready at
	// ~t+7m30s (their containers started at t+5m51s and t+6m48s) instead of restart-looping, and
	// redis was Ready at t+12m27s. Dex is then the only pole left, and it had been pulling for
	// ~4m20s at the deadline with the five competing pulls already finished — so the install
	// converges somewhere around t+14–17m. 15m sat INSIDE that band, which is exactly why it failed
	// by seconds rather than by minutes. 20m clears the top of it with a few minutes to spare.
	//
	// The ceiling is unchanged and still binds: gcp's WaitTerminal is 50m (test/e2e/t2_providers.go),
	// and this same run measured the rest of the spine directly — the runner claimed the job at
	// 08:43:19 and failed at 09:14:47, i.e. 31m28s WITH the full 15m wait consumed, so everything
	// before ArgoCD costs ~16m30s. 16m30s + 20m + the 10m addonConvergeTimeout = ~46m30s, which
	// fits. 25m would not, so the next step after this one is NOT another minute of deadline — it
	// is the node shape (the gcp floor's `e2-small` / 20 GB pd-standard, a per-run cost and the
	// maintainer's call) or the env override, ALETHIA_ARGOCD_INSTALL_TIMEOUT.
	//
	// Deliberately still a FLAT constant, not scaled from the project config. The thing that
	// actually varies here is node image-pull throughput — a function of disk type, machine size,
	// registry and how many pods share the node — and the runner holds NONE of that at this point:
	// it has tofu outputs and a ProjectConfig, neither of which names a disk class. A formula over
	// the inputs we DO have would be a guess wearing the costume of a measurement, and the honest
	// per-run knob already exists.
	DefaultArgoInstallTimeout = "20m"
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
