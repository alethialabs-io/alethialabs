// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

package e2e

import (
	"context"
	"errors"
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
	//
	// CommandContext, not a goroutine racing a timer. The previous shape read `cmd.Process` from
	// this goroutine while `CombinedOutput` → `Start` wrote it in another — a data race `go test
	// -race` flags, and a nil dereference whenever Start had not returned or had failed. A panic
	// there would abort this t.Cleanup closure BEFORE teardownT2Cluster, so a best-effort
	// REPORTING convenience would take the graceful `tofu destroy` with it and leak the whole
	// cluster: the exact opposite of the "best effort, silent on failure" contract above.
	cctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "bash", script, "--capture-lbs", out, clusterName)
	cmd.Env = os.Environ()
	combined, runErr := cmd.CombinedOutput()
	if errors.Is(cctx.Err(), context.DeadlineExceeded) {
		t.Log("hetzner LB capture: timed out; the teardown sweep falls back to the project-wide question")
		return
	}
	if runErr != nil {
		t.Logf("hetzner LB capture failed (%v) — falling back:\n%s", runErr, combined)
		return
	}
	t.Logf("hetzner LB capture → %s\n%s", out, combined)
}
