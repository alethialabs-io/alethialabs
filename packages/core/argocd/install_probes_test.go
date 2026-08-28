// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"testing"

	"gopkg.in/yaml.v3"
)

// probeSpec is the subset of a Kubernetes probe the chart lets us set. Parsed out of the rendered
// values rather than read back off the constants: a test that asserts
// `ProbeTimeoutSeconds == ProbeTimeoutSeconds` is true by construction and proves nothing about
// what helm receives. Everything below goes through the YAML.
type probeSpec struct {
	InitialDelaySeconds int `yaml:"initialDelaySeconds"`
	PeriodSeconds       int `yaml:"periodSeconds"`
	TimeoutSeconds      int `yaml:"timeoutSeconds"`
	FailureThreshold    int `yaml:"failureThreshold"`
}

// notReadyAfter is how long a container may keep failing before the kubelet stops routing traffic
// to it; restartedAfter is how long before it is killed. These are the numbers a reviewer actually
// cares about — the individual fields are only how you spell them.
func (p probeSpec) window() int {
	return p.InitialDelaySeconds + p.FailureThreshold*p.PeriodSeconds
}

type probeComponent struct {
	Readiness *probeSpec `yaml:"readinessProbe"`
	Liveness  *probeSpec `yaml:"livenessProbe"`
}

func parseProbeValues(t *testing.T) map[string]probeComponent {
	t.Helper()
	var got map[string]probeComponent
	if err := yaml.Unmarshal([]byte(InstallProbeValues()), &got); err != nil {
		t.Fatalf("InstallProbeValues is not valid YAML — helm would reject the whole values file: %v\n%s", err, InstallProbeValues())
	}
	return got
}

// TestInstallProbeValuesCoverEveryProbeTheChartENABLES pins that the three workloads whose probes
// argo-cd 9.5.11 turns on by default all get widened values, and that nothing else does.
//
// The "and nothing else" half is not tidiness. `dex`, `applicationSet`, `notifications` and `redis`
// ship `enabled: false` probes in BOTH 8.6.4 and 9.5.11 and we never enable them, so values for
// them would render nothing at all while reading, in review, exactly like a fix.
func TestInstallProbeValuesCoverEveryProbeTheChartENABLES(t *testing.T) {
	got := parseProbeValues(t)

	// controller has a readiness probe and NO liveness probe in the chart. Asserting the absence is
	// deliberate: inventing a livenessProbe key here would be silently ignored by helm, and the
	// test would still "pass".
	for _, tc := range []struct {
		component    string
		wantReady    bool
		wantLiveness bool
	}{
		{component: "controller", wantReady: true, wantLiveness: false},
		{component: "server", wantReady: true, wantLiveness: true},
		{component: "repoServer", wantReady: true, wantLiveness: true},
	} {
		c, ok := got[tc.component]
		if !ok {
			t.Fatalf("%s has no widened probes — the chart enables its probes by default at timeoutSeconds 1, which restart-loops on a burstable node", tc.component)
		}
		if (c.Readiness != nil) != tc.wantReady {
			t.Errorf("%s readinessProbe present = %v, want %v", tc.component, c.Readiness != nil, tc.wantReady)
		}
		if (c.Liveness != nil) != tc.wantLiveness {
			t.Errorf("%s livenessProbe present = %v, want %v — the chart gives the application-controller no liveness probe, so a key here renders nothing", tc.component, c.Liveness != nil, tc.wantLiveness)
		}
		delete(got, tc.component)
	}
	for leftover := range got {
		t.Errorf("values set probes for %q, whose probes the chart ships `enabled: false` and which we never enable — this renders NOTHING and reads like a fix", leftover)
	}
}

// TestInstallProbeValuesSurviveAStarvedNode is the guard against the defect. Every widened probe
// must tolerate a slow answer AND a run of consecutive slow answers, because that is precisely what
// gcp run 33156252646 recorded: `Client.Timeout exceeded while awaiting headers` at the chart's
// 1-second timeout, twice over, on two different components.
//
// The floors are stated as inequalities rather than as the exact constants so the test asserts a
// PROPERTY ("no burstable node can be killed mid-startup") rather than a transcription. It fails
// against the chart's defaults (timeoutSeconds 1, failureThreshold 3) on every line.
func TestInstallProbeValuesSurviveAStarvedNode(t *testing.T) {
	// The chart's own defaults, from `helm show values argo/argo-cd --version 9.5.11`. Identical in
	// 8.6.4. Named so a failure says what the value regressed TO.
	const (
		chartTimeoutSeconds   = 1
		chartFailureThreshold = 3
	)
	for component, c := range parseProbeValues(t) {
		for kind, p := range map[string]*probeSpec{"readinessProbe": c.Readiness, "livenessProbe": c.Liveness} {
			if p == nil {
				continue
			}
			if p.TimeoutSeconds <= chartTimeoutSeconds {
				t.Errorf("%s.%s timeoutSeconds = %d — at or below the chart default of %d, which is the exact value that produced `Client.Timeout exceeded while awaiting headers` on the e2-small floor node",
					component, kind, p.TimeoutSeconds, chartTimeoutSeconds)
			}
			if p.TimeoutSeconds < 5 {
				t.Errorf("%s.%s timeoutSeconds = %d, want >= 5 — a CPU-starved node could not complete a TCP handshake inside one second", component, kind, p.TimeoutSeconds)
			}
			if p.FailureThreshold <= chartFailureThreshold {
				t.Errorf("%s.%s failureThreshold = %d — at or below the chart default of %d, so one burst of starvation is still a third of the way to a verdict",
					component, kind, p.FailureThreshold, chartFailureThreshold)
			}
			if p.TimeoutSeconds >= p.PeriodSeconds {
				t.Errorf("%s.%s timeoutSeconds %d >= periodSeconds %d — probes would overlap, so the effective period is no longer the one stated here",
					component, kind, p.TimeoutSeconds, p.PeriodSeconds)
			}
		}
	}
}

// TestInstallProbeValuesStillNoticeADeadPod is the OTHER direction, and it is the half that stops
// this change from being "turn the probes off". A widened probe that never fires is not resilience,
// it is a pod that serves errors forever.
//
// It also pins the split that makes the numbers defensible: readiness must declare a pod not-Ready
// STRICTLY BEFORE liveness restarts it, so a sick pod stops taking traffic well before it is killed.
func TestInstallProbeValuesStillNoticeADeadPod(t *testing.T) {
	// Ceilings, in seconds. A dead pod must be out of Service endpoints inside two minutes and
	// restarted inside three — both comfortably inside ordinary Kubernetes practice, and both far
	// below the 20m install deadline they have to fit inside.
	const (
		maxNotReadySeconds = 120
		maxRestartSeconds  = 180
	)
	for component, c := range parseProbeValues(t) {
		if c.Readiness != nil {
			if w := c.Readiness.window(); w > maxNotReadySeconds {
				t.Errorf("%s takes %ds of consecutive failures to be pulled out of Service endpoints, want <= %ds — a genuinely dead pod would keep taking traffic", component, w, maxNotReadySeconds)
			}
		}
		if c.Liveness != nil {
			if w := c.Liveness.window(); w > maxRestartSeconds {
				t.Errorf("%s takes %ds of consecutive failures to be restarted, want <= %ds", component, w, maxRestartSeconds)
			}
			if c.Readiness == nil {
				continue
			}
			if c.Readiness.window() >= c.Liveness.window() {
				t.Errorf("%s: readiness window %ds >= liveness window %ds — the pod would be killed no later than it stopped taking traffic, so the restart happens while it is still serving",
					component, c.Readiness.window(), c.Liveness.window())
			}
		}
	}
}
