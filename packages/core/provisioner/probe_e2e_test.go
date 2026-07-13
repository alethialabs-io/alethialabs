// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_local

// The T0 cluster-alive proof (BYOC B2.2). Build-tagged `e2e_local` so it is OFF by
// default (bare `go test` / every-PR CI) and ON only where docker + kind + kubectl are
// available:
//
//	go test -tags=e2e_local ./provisioner/ -run E2ELocalKindProbe
//
// It drives the REAL RunProbe spine — ReadStateOutputs (state proxy) -> provider
// ConfigureKubeconfig -> bounded /readyz dial — against a genuine local `kind` cluster
// (no cloud account, no cloud creds), then proves the honest LIVE -> DEAD transition:
// a reachable cluster reports Reachable=true with a real server version + Ready nodes,
// and after the apiserver is genuinely STOPPED the same probe reports Reachable=false
// while the job still SUCCEEDS (nil error). The transition is real, not hardcoded.
package provisioner

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// requireKindOrSkip skips cleanly when kind/kubectl aren't available.
func requireKindOrSkip(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"kind", "kubectl"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH — skipping the kind probe E2E", bin)
		}
	}
}

// TestE2ELocalKindProbe is the keystone T0 proof for RunProbe.
func TestE2ELocalKindProbe(t *testing.T) {
	requireKindOrSkip(t)
	requireDockerOrSkip(t) // defined in deploy_e2e_test.go (same e2e_local build)

	id := shortID(t)
	clusterName := "alethia-probe-" + id
	nodeContainer := clusterName + "-control-plane"

	// GUARANTEED teardown, registered before creation so it runs even on a mid-test failure.
	t.Cleanup(func() {
		dctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := exec.CommandContext(dctx, "kind", "delete", "cluster", "--name", clusterName).Run(); err != nil {
			t.Logf("kind delete failed (%v) — falling back to docker rm", err)
			_ = exec.Command("docker", "rm", "-f", nodeContainer).Run()
		}
	})

	// 1. Stand up a dedicated throwaway kind cluster.
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	create := exec.CommandContext(cctx, "kind", "create", "cluster", "--name", clusterName, "--wait", "90s")
	if out, err := create.CombinedOutput(); err != nil {
		t.Fatalf("kind create cluster: %v\n%s", err, out)
	}

	// 2. Capture the cluster's kubeconfig + server endpoint.
	rawKubeconfig, err := exec.CommandContext(cctx, "kind", "get", "kubeconfig", "--name", clusterName).Output()
	if err != nil || len(rawKubeconfig) == 0 {
		t.Fatalf("kind get kubeconfig: %v", err)
	}
	endpoint := kindServerEndpoint(t, string(rawKubeconfig))

	// 3. Seed the in-memory state proxy with the outputs a hetzner/Talos env would carry
	//    (the kubeconfig is a sensitive output that RunProbe must read in-process).
	srv := startTestStateServer(t)
	seedTestState(t, srv, map[string]any{
		"talos_cluster_name":     clusterName,
		"talos_cluster_endpoint": endpoint,
		"kubeconfig":             string(rawKubeconfig),
	})

	vc := newLocalProjectConfig("alethia", "probe"+id)
	backend := testStateBackend(srv)

	// ── LIVE: the probe must actually reach the real kind API server. ────────────────
	var liveOut, liveErr bytes.Buffer
	pctx, pcancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer pcancel()
	live, err := RunProbe(pctx, ProbeParams{
		ProjectConfig: vc, Provider: "hetzner", StateBackend: backend,
		Timeout: 20 * time.Second, Stdout: &liveOut, Stderr: &liveErr,
	})
	if err != nil {
		t.Fatalf("RunProbe (live) returned an operational error: %v\nstderr:%s", err, liveErr.String())
	}
	if !live.Reachable {
		t.Fatalf("LIVE probe: Reachable=false against a healthy kind cluster (detail: %+v)", live.Detail)
	}
	// Defeat a vacuous true: the probe genuinely spoke to a real API server.
	if live.Detail.StatusCode != 200 {
		t.Fatalf("LIVE probe: StatusCode = %d, want 200 (/readyz did not answer ok)", live.Detail.StatusCode)
	}
	if live.Detail.ServerVersion == "" {
		t.Fatal("LIVE probe: empty ServerVersion — the probe did not actually query the API server")
	}
	if live.Detail.ReadyNodeCount < 1 {
		t.Fatalf("LIVE probe: ReadyNodeCount = %d, want >=1 (a real kind node)", live.Detail.ReadyNodeCount)
	}
	if live.Detail.LatencyMs <= 0 {
		t.Fatal("LIVE probe: LatencyMs<=0 — the dial was not measured")
	}
	// The secret kubeconfig must never appear in the probe logs.
	if strings.Contains(liveOut.String(), "client-certificate-data") || strings.Contains(liveOut.String(), "client-key-data") {
		t.Fatal("LIVE probe: kubeconfig credential material leaked into the logs")
	}
	t.Logf("LIVE probe: reachable=%v server=%s nodes=%d/%d latency=%dms",
		live.Reachable, live.Detail.ServerVersion, live.Detail.ReadyNodeCount, live.Detail.NodeCount, live.Detail.LatencyMs)

	// ── DEAD: genuinely stop the API server, then re-probe the SAME env. ─────────────
	if out, serr := exec.Command("docker", "stop", nodeContainer).CombinedOutput(); serr != nil {
		t.Fatalf("failed to stop the kind control-plane container: %v\n%s", serr, out)
	}

	var deadOut, deadErr bytes.Buffer
	dctx, dcancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer dcancel()
	dead, err := RunProbe(dctx, ProbeParams{
		ProjectConfig: vc, Provider: "hetzner", StateBackend: backend,
		Timeout: 12 * time.Second, Stdout: &deadOut, Stderr: &deadErr,
	})
	// The crux: a DEAD cluster is a SUCCESSFUL probe with Reachable=false — NOT a job error.
	if err != nil {
		t.Fatalf("DEAD probe returned an error — unreachable must be SUCCESS reachable=false, not a job failure: %v", err)
	}
	if dead.Reachable {
		t.Fatalf("DEAD probe: Reachable=true after the API server was stopped (detail: %+v)", dead.Detail)
	}
	if dead.Detail.Error == "" {
		t.Fatal("DEAD probe: empty failure reason — an unreachable cluster must record WHY")
	}
	if strings.Contains(deadOut.String(), "client-key-data") {
		t.Fatal("DEAD probe: kubeconfig credential material leaked into the logs")
	}
	t.Logf("DEAD probe: reachable=%v reason=%q", dead.Reachable, dead.Detail.Error)

	// Non-vacuous transition: the SAME probe against the SAME env flipped true -> false
	// purely because the API server died.
	if live.Reachable == dead.Reachable {
		t.Fatal("no reachability transition observed — the probe result did not change when the API server was killed")
	}
}

// kindServerEndpoint extracts the API-server URL from a kind kubeconfig via kubectl.
func kindServerEndpoint(t *testing.T, kubeconfig string) string {
	t.Helper()
	dir := t.TempDir()
	kc := dir + "/kubeconfig"
	if err := os.WriteFile(kc, []byte(kubeconfig), 0o600); err != nil {
		t.Fatalf("write kubeconfig: %v", err)
	}
	out, err := exec.Command("kubectl", "--kubeconfig="+kc, "config", "view", "-o",
		"jsonpath={.clusters[0].cluster.server}").Output()
	if err != nil {
		t.Logf("could not read server endpoint (non-fatal): %v", err)
		return ""
	}
	return strings.TrimSpace(string(out))
}
