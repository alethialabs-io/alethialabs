// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestNoJobTypeIsAStub is the test that would have caught this bug, and none of the existing ones
// could have.
//
// `provisioner.RunProbe` was fully implemented AND had its own unit + e2e tests. The console
// dispatched PROBE_CLUSTER on a schedule and from the canvas Run menu. The status route ingested
// `probe_result` into environment_probes and alerted on an outage. Every piece was built and
// tested — and the runner's dispatch switch answered every one of those jobs with
// "not yet implemented on this runner (BYOC B2.2)". So every probe job failed, environment_probes
// was never written, and a cluster whose API server had died still read "Live" on the canvas.
//
// Testing a function proves the function works. It does not prove anything CALLS it. This asserts
// the dispatch switch has no stubbed arm left in it — the invariant that actually failed.
func TestNoJobTypeIsAStub(t *testing.T) {
	src, err := os.ReadFile("runner.go")
	if err != nil {
		t.Fatalf("read runner.go: %v", err)
	}
	// Only the dispatch switch matters; a "not yet implemented" inside a doc comment explaining the
	// history (as probe.go's does) is fine. Look at executable lines only.
	for i, line := range strings.Split(string(src), "\n") {
		code := line
		if idx := strings.Index(code, "//"); idx >= 0 {
			code = code[:idx]
		}
		if strings.Contains(code, "not yet implemented") {
			t.Errorf("runner.go:%d dispatches a job type to a stub — the console can queue it, so it "+
				"will fail for every user:\n\t%s", i+1, strings.TrimSpace(line))
		}
	}
}

// TestProbeClusterIsWired drives the executor and asserts it actually RUNS: it parses the snapshot,
// reaches for the state token, and calls through to `provisioner.RunProbe`.
//
// It needs no cluster. RunProbe reads the environment's outputs from the console's state proxy, and
// with no proxy reachable that read fails — which is exactly the contract worth pinning: the probe
// could not RUN, an OPERATIONAL failure, and deliberately NOT the same thing as an honest "the
// cluster is down" (which RunProbe reports as a SUCCESSFUL probe carrying reachable=false, so the
// canvas can render `unreachable` rather than a failed job).
//
// Before the fix this returned "not yet implemented" and touched none of that machinery.
func TestProbeClusterIsWired(t *testing.T) {
	api := &mockAPI{jobs: map[string]*Job{}}
	w := &Runner{api: api}

	job := &Job{
		ID:      "job-probe-1",
		JobType: string(types.JobTypeProbeCluster),
		ConfigSnapshot: map[string]any{
			"provider":     "hetzner",
			"iac_version":  "1.11.4",
			"project_name": "probe-test",
		},
	}
	stdout := NewJobLogger(api, job.ID, "stdout")
	stderr := NewJobLogger(api, job.ID, "stderr")

	err := w.executeProbeCluster(context.Background(), job, "hetzner", nil, stdout, stderr)

	// The one thing that must never be true again.
	if err != nil && strings.Contains(err.Error(), "not yet implemented") {
		t.Fatalf("PROBE_CLUSTER is still a stub: %v", err)
	}
	// No state proxy in a unit test → the probe cannot RUN, so it must report an operational error
	// rather than silently claiming the cluster is fine.
	if err == nil {
		t.Error("expected an operational error with no state proxy reachable; got nil (a probe that " +
			"cannot read state must never pass for a healthy cluster)")
	}

	api.mu.Lock()
	defer api.mu.Unlock()

	// It announced itself before doing any work, so a slow probe shows as running rather than
	// sitting in QUEUED. This is also the proof the executor was REACHED at all.
	var announced bool
	for _, u := range api.statusUpdates {
		if u.jobID == job.ID && u.status == "PROCESSING" && u.metadata["phase"] == "probe" {
			announced = true
		}
	}
	if !announced {
		t.Error("executeProbeCluster never posted its PROCESSING phase — the executor was not reached")
	}

	// A probe that could not run must NOT post a probe_result: the console ingests that into
	// environment_probes as fact, and a fabricated reachable=false would raise a false outage alert.
	for _, u := range api.statusUpdates {
		if _, ok := u.metadata["probe_result"]; ok {
			t.Error("posted a probe_result even though the probe could not run — the console would " +
				"record a cluster outage that never happened")
		}
	}
}
