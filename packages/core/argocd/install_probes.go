// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import "fmt"

// The argo-cd chart's DEFAULT health probes are hostile to a small, burstable node, and they are
// what turns a slow install into a failed one. This file is the one place that widens them, and it
// is applied to EVERY install on every cloud — not just the ones with an ingress.
//
// ── The chart's defaults, read out of the pinned chart, not remembered ──
//
// `helm show values argo/argo-cd --version 9.5.11` (and 8.6.4 — the two are numerically IDENTICAL
// here; 9.5.11 only adds an explicit `enabled: true` key to the two that had none) ships this for
// every probe it enables by default:
//
//	timeoutSeconds: 1 · periodSeconds: 10 · failureThreshold: 3 · initialDelaySeconds: 10
//
// A liveness probe with those numbers kills its container after ~40s of a container being slow to
// answer ONE HTTP GET within ONE second. On a node whose CPU is shared and already saturated, that
// is not a health check — it is a restart-loop generator, and each restart puts the pod back to the
// start of its own startup while the node is still the bottleneck.
//
// ── The measurement (gcp e2e floor run 33156252646, `e2-small`, 20 GB pd-standard) ──
//
// Six pods pull ~200 MB images concurrently onto one node. What the kubelet recorded:
//
//	Pulled  redis   …in 6m29.827s (11m48.225s including waiting). Image size: 16855420 bytes
//	Pulled  server / repo-server  …in ~6s (5m19s including waiting)
//	7m57s  Normal   Killing    argocd-server       Container server failed liveness probe, will be restarted
//	   6s  Normal   Killing    argocd-repo-server  Container repo-server failed liveness probe, will be restarted
//	       Warning  Unhealthy  Liveness probe failed: Get "…/healthz?full=true":
//	                           net/http: request canceled while waiting for connection
//	                           (Client.Timeout exceeded while awaiting headers)
//
// 16.9 MB of redis took 6m29s of PULL — ~43 KB/s. `Client.Timeout exceeded while awaiting headers`
// IS the 1-second probe timeout firing, and `while waiting for connection` says the prober could
// not even complete a TCP handshake inside it. So the two components were not "slow but
// converging": they were being killed and restarted, and repo-server's second kill landed SIX
// SECONDS before the 15m install deadline expired. No deadline covers that, because the restart
// resets the pod's readiness every time.
//
// ── The numbers below, and why each one ──
//
// The split is deliberate: READINESS de-routes a sick pod fast, LIVENESS restarts it slowly. They
// answer different questions and should not share a window.
//
//	timeoutSeconds: 1 → 10        The defect itself. A starved process must be allowed to answer
//	                              LATE. 10s is the same order as the delays actually observed on
//	                              this node (a TCP connect that could not complete in 1s), and it
//	                              is still an order of magnitude below any of the windows below,
//	                              so a hung process still fails every probe in the window.
//	failureThreshold: 3 → 6       One transient stall must not be 1/3 of the way to a kill.
//	readiness period 10 → 15      Keeps the timeout strictly below the period, so probes cannot
//	                              overlap. Costs at most 15s of extra latency on the flip TO Ready
//	                              — noise against a 20m install budget.
//	liveness initialDelay 10 → 30 Do not even ASK until startup is plausibly done.
//	liveness period 10 → 20       With the threshold, this is what sets the kill window.
//
// The resulting windows, which are the numbers that actually matter:
//
//	not-Ready declared after  10 + 6×15 = 100s of consecutive failures (was 10 + 3×10 = 40s)
//	restarted after           30 + 6×20 = 150s of consecutive failures (was 10 + 3×10 = 40s)
//
// 2m30s to restart a genuinely dead pod is well inside ordinary Kubernetes practice, and readiness
// has already pulled it out of Service endpoints 50 seconds earlier — so a dead pod stops taking
// traffic in well under two minutes and is restarted in well under three. Nothing here defers a
// real failure to "eventually"; it defers it past a burst of CPU starvation.
//
// ── What is deliberately NOT here ──
//
// `dex`, `applicationSet`, `notifications` and `redis` ship their probes `enabled: false` in both
// 8.6.4 and 9.5.11, and we do not enable them — so widening their values would be configuration
// that renders nothing, the kind that reads as a fix and is not one. This was the specific
// disconfirming check: dex was the pod still stuck at the 15m deadline
// (`0/1 PodInitializing 15m`), and it was stuck on an IMAGE PULL, with no probe involved at all.
// That is why the deadline had to move as well; the probes alone would not have saved this run.
//
// `commitServer` DOES ship enabled probes but `commitServer.enabled: false`, so it is not deployed.
//
// Verified by rendering `helm template argo-cd argo/argo-cd --version <v> -f <these values>`
// against BOTH 8.6.4 and 9.5.11: exactly three workloads change, identically on both charts —
// argocd-repo-server (Deployment), argocd-server (Deployment) and argocd-application-controller
// (StatefulSet, readiness only; the chart gives it no liveness probe).
const (
	// ProbeTimeoutSeconds is how long the kubelet waits for ONE probe response. The chart's 1s is
	// the whole defect.
	ProbeTimeoutSeconds = 10
	// ProbeFailureThreshold is how many CONSECUTIVE failures count as a verdict.
	ProbeFailureThreshold = 6

	// ReadinessInitialDelaySeconds / ReadinessPeriodSeconds bound how fast a pod is pulled out of
	// Service endpoints — and, once healthy, how fast it is put back.
	ReadinessInitialDelaySeconds = 10
	ReadinessPeriodSeconds       = 15

	// LivenessInitialDelaySeconds / LivenessPeriodSeconds bound how fast a container is RESTARTED.
	// Strictly slower than readiness, on purpose.
	LivenessInitialDelaySeconds = 30
	LivenessPeriodSeconds       = 20
)

// InstallProbeValues renders the argo-cd chart values that replace the chart's default health
// probes with ones a CPU-starved, slow-disk node can actually satisfy.
//
// Returned as a values FILE body rather than `--set` flags for the same reason as the per-cloud
// ingress values: it is a static nested document, and a values file states the whole shape in one
// readable place instead of a dozen escaped `--set` keys on a shell command line.
//
// It takes no arguments and cannot fail — the values are constants, not project data — so unlike
// GKEArgoServerValues there is no error to return and no input to fail closed on.
func InstallProbeValues() string {
	probe := func(initialDelay, period int) string {
		return fmt.Sprintf(
			"    initialDelaySeconds: %d\n"+
				"    periodSeconds: %d\n"+
				"    timeoutSeconds: %d\n"+
				"    failureThreshold: %d\n",
			initialDelay, period, ProbeTimeoutSeconds, ProbeFailureThreshold)
	}
	readiness := "  readinessProbe:\n" + probe(ReadinessInitialDelaySeconds, ReadinessPeriodSeconds)
	liveness := "  livenessProbe:\n" + probe(LivenessInitialDelaySeconds, LivenessPeriodSeconds)

	// `controller` has a readiness probe and no liveness probe in the chart — it cannot be killed by
	// a probe, but a readiness probe that times out at 1s keeps it out of `helm --wait`'s idea of
	// ready, which spends the install deadline just as effectively.
	return "controller:\n" + readiness +
		"server:\n" + readiness + liveness +
		"repoServer:\n" + readiness + liveness
}
