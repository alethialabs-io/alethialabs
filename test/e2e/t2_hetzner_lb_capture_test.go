// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

package e2e

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// hetznerRepoRoot resolves the repository root relative to THIS file (test/e2e/<file>). The
// identical helper in t1_provision_test.go sits behind the `e2e_t1` tag and is invisible here.
func hetznerRepoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

// hetznerLBCaptureBasename is the file scripts/e2e/hcloud-cleanup.sh reads the captured binding
// back from, under $RUNNER_TEMP.
//
// ⚠️ A FIXED PATH, not an environment variable set here, and that is not a shortcut. The sweeper
// runs in a DIFFERENT PROCESS — the workflow's always() teardown step, long after this test has
// exited — so anything this process exports is invisible to it. The workflow points
// ALETHIA_E2E_HCLOUD_LB_IDS at the same path (e2e-nightly.yml, both teardown steps); the two ends
// agree by construction rather than by a hand-off that cannot happen.
const hetznerLBCaptureBasename = "hcloud-lb-ids.txt"

// captureHetznerLoadBalancers records this run's Load Balancer ids WHILE the private network that
// binds them still exists, so the post-teardown sweep has a run-scoped binding afterwards.
//
// The hetzner CCM's ingress Load Balancer carries no hcloud label and cannot be made to; its only
// binding to this run is its private-network attachment, and `tofu destroy` deletes that network
// first. So on the GRACEFUL path the sweep has nothing left to bind with and asks whether the
// PROJECT holds any load balancer at all — which lets a concurrent run's LB red this leg, and
// makes a FAILED teardown verify cleanly while a SUCCESSFUL one does not (#3481).
//
// ⚠️ BEST EFFORT, AND SILENT ON FAILURE BY DESIGN. Everything it protects is a REPORTING decision
// in the sweeper, never a delete: with no capture the sweeper falls back to the project-wide
// question, which over-reports and reds — the safe direction. Failing a teardown because a
// pre-teardown convenience did not run would trade a false red for a real one.
//
// It writes nothing when the capture fails, which is NOT the same as writing an empty file: the
// sweeper reads an empty file as "this run held none". Both ends refuse that, because it is the one
// mistake here that converts a loud fallback into a silent green.
func captureHetznerLoadBalancers(t *testing.T, provider, clusterName string) {
	t.Helper()
	if provider != "hetzner" || clusterName == "" {
		return
	}
	if os.Getenv("HCLOUD_TOKEN") == "" {
		return // nothing to authenticate with; the sweeper's fallback still gates
	}
	dir := os.Getenv("RUNNER_TEMP")
	if dir == "" {
		return // not a CI runner: the sweeper the file is for does not run here either
	}
	out := filepath.Join(dir, hetznerLBCaptureBasename)

	script := filepath.Join(hetznerRepoRoot(t), "scripts", "e2e", "hcloud-cleanup.sh")
	if _, err := os.Stat(script); err != nil {
		t.Logf("hetzner LB capture: %s is not present (%v) — the teardown sweep falls back to the "+
			"project-wide question, which over-reports rather than under-reports", script, err)
		return
	}
	// Bounded: this runs inside the teardown window and must not eat it. Two API reads.
	cmd := exec.Command("bash", script, "--capture-lbs", out, clusterName)
	cmd.Env = os.Environ()
	done := make(chan struct{})
	var combined []byte
	var runErr error
	go func() {
		combined, runErr = cmd.CombinedOutput()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(90 * time.Second):
		_ = cmd.Process.Kill()
		t.Log("hetzner LB capture: timed out; the teardown sweep falls back to the project-wide question")
		return
	}
	if runErr != nil {
		t.Logf("hetzner LB capture failed (%v) — falling back:\n%s", runErr, combined)
		return
	}
	t.Logf("hetzner LB capture → %s\n%s", out, combined)
}
