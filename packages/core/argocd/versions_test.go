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

// TestDefaultArgoInstallTimeoutFitsTheMeasuredBudget is a TWO-SIDED guard on the deadline, and the
// second side is the point of it. A deadline can be wrong by being too short — 15m was, and gcp
// floor run 33156252646 died on it — but it can equally be wrong by being too LONG: the wait sits
// inside the runner job, and the job has to reach a terminal status inside the e2e harness's
// per-provider WaitTerminal or the run is recorded as a failure with no verdict at all.
//
// Both bounds come from that same run, not from taste:
//
//   - FLOOR. Server and repo-server became Ready at ~t+7m30s once their liveness kills are removed
//     (InstallProbeValues), redis at t+12m27s, and dex — a pure image pull, no probe involved — was
//     still pulling at the 15m deadline having only STARTED at t+10m37s. The install converges in
//     the t+14–17m band, which is why 15m failed by seconds. Anything at or below 17m re-creates it.
//   - CEILING. gcp's WaitTerminal is 50m (test/e2e/t2_providers.go). The same run measured the rest
//     of the spine directly: the runner claimed the job at 08:43:19 and failed at 09:14:47 — 31m28s
//     with the full 15m wait consumed, so everything before ArgoCD costs ~16m30s. The post-install
//     work is bounded by addonConvergeTimeout, 10m (packages/core/provisioner/deploy.go).
//
// The constants below restate the two numbers this package cannot import (WaitTerminal lives in
// test/e2e, addonConvergeTimeout is unexported in provisioner). That restatement is the risk this
// test carries, so each one names its source.
func TestDefaultArgoInstallTimeoutFitsTheMeasuredBudget(t *testing.T) {
	const (
		gcpWaitTerminal      = 50 * time.Minute // test/e2e/t2_providers.go, t2ProviderTable["gcp"].waitTimeout
		spineBeforeArgo      = 16*time.Minute + 30*time.Second
		addonConvergeCeiling = 10 * time.Minute // packages/core/provisioner/deploy.go addonConvergeTimeout()
		observedConvergence  = 17 * time.Minute
	)
	d, err := time.ParseDuration(DefaultArgoInstallTimeout)
	if err != nil {
		t.Fatalf("DefaultArgoInstallTimeout %q does not parse: %v", DefaultArgoInstallTimeout, err)
	}
	if d <= observedConvergence {
		t.Errorf("DefaultArgoInstallTimeout = %v, which does not clear the %v the gcp floor install was measured to need (run 33156252646) — 15m failed there by seconds", d, observedConvergence)
	}
	if total := spineBeforeArgo + d + addonConvergeCeiling; total > gcpWaitTerminal {
		t.Errorf("DefaultArgoInstallTimeout = %v puts the worst-case job at %v, past gcp's %v WaitTerminal — the run would be recorded FAILED with no verdict. Raise the node shape or the harness budget, not this constant", d, total, gcpWaitTerminal)
	}
}
