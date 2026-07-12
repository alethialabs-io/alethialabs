// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_local

// Package provisioner's T0 provisioning-E2E keystone. Build-tagged `e2e_local` so
// it is OFF by default (bare `go test` / every-PR CI) and ON only where docker +
// tofu are available (a local run, or the merge-queue T1 job a later PR wires up):
//
//	go test -tags=e2e_local ./provisioner/ -run E2E
//
// It drives the REAL provisioner.RunDeployV2 spine — plan -> verify gate ->
// signed evidence receipt -> apply -> ConfigureKubeconfig -> WaitClusterReady ->
// WaitPodToAPIServer -> ArgoCD — against a genuine local `kind` cluster, with no
// cloud account and no cloud credentials.
package provisioner

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// repoRoot resolves the repository root as an absolute path, relative to THIS test
// file (not the process CWD) — packages/core/provisioner/<file> is three dirs deep.
// Lives in this e2e_local-tagged file because only the tagged test uses it.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

// absTemplatesDir resolves a bundled project template dir to an absolute path.
func absTemplatesDir(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(repoRoot(t), "infra", "templates", "project", name)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("template dir %s not found: %v", dir, err)
	}
	return dir
}

// requireDockerOrSkip skips cleanly when docker isn't usable, so bare CI without a
// docker daemon does not FAIL this test (the merge-queue T1 job provides docker).
func requireDockerOrSkip(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not on PATH — skipping the kind E2E")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "docker", "info").Run(); err != nil {
		t.Skipf("docker daemon not reachable (%v) — skipping the kind E2E", err)
	}
}

// TestE2ELocalKindProvisioning is the keystone. A green run PROVES the post-apply
// cluster spine actually executed against a real Kubernetes API — not that "tofu
// apply exited 0". See the assertions block for how each silent-skip is defeated.
func TestE2ELocalKindProvisioning(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping the kind E2E")
	}
	requireDockerOrSkip(t)

	// Fail FAST if the kind cluster is broken: the gates default to 15m, which would
	// hang a broken run; 3m is plenty for a healthy local kind cluster.
	t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "3m")

	// Configure receipt signing so we can assert a sealed AND signed receipt.
	priv, pub := genEd25519(t)
	t.Setenv("ALETHIA_RECEIPT_SIGNING_KEY", base64.StdEncoding.EncodeToString(priv))

	// The ArgoCD tail of the spine reads baked infra-service templates; point the
	// runner's resolver at the repo's copy (its relative fallback assumes the
	// runner-image CWD, not the test binary's package dir).
	t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", filepath.Join(repoRoot(t), "infra", "templates", "argocd"))

	srv := startTestStateServer(t)

	env := "e2e" + shortID(t)
	vc := newLocalProjectConfig("alethia", env)
	templatesDir := absTemplatesDir(t, "local")
	backend := testStateBackend(srv)
	logw := tLogWriter{t}

	// GUARANTEED teardown — registered BEFORE the deploy so it runs even if the
	// deploy panics/fails midway. Cleanups are LIFO and the state-server Close was
	// registered earlier (inside startTestStateServer), so destroy runs first (it
	// needs the state server), then the server closes. A docker-level fallback
	// removes the kind container if `tofu destroy` itself failed, so no cluster leaks.
	clusterName := vc.ProjectName + "-" + vc.EnvironmentStage
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer dcancel()
		if err := RunDestroy(dctx, DestroyParams{
			ProjectConfig: vc,
			Provider:      "hetzner",
			TemplatesDir:  templatesDir,
			StateBackend:  backend,
			Stdout:        logw,
			Stderr:        logw,
		}); err != nil {
			t.Logf("RunDestroy failed (%v) — falling back to docker rm of the kind node", err)
			_ = exec.Command("docker", "rm", "-f", clusterName+"-control-plane").Run()
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	result, err := RunDeployV2(ctx, DeployParams{
		ProjectConfig: vc,
		Provider:      "hetzner", // reuse the Talos post-apply path; ExtractClusterName keys on talos_cluster_name
		TemplatesDir:  templatesDir,
		StateBackend:  backend,
		DryRun:        false,
		Stdout:        logw,
		Stderr:        logw,
	})
	if err != nil {
		t.Fatalf("RunDeployV2 against local kind: %v", err)
	}

	// ── Defeat the silent-skip vacuous pass ──────────────────────────────────
	//
	// (1) ClusterName != "" proves ExtractClusterName found talos_cluster_name and
	//     the post-apply spine was NOT skipped.
	if result.ClusterName == "" {
		t.Fatal("ClusterName is empty — the post-apply spine was SKIPPED (ExtractClusterName found no talos_cluster_name output)")
	}
	if result.ClusterName != clusterName {
		t.Fatalf("ClusterName = %q, want %q", result.ClusterName, clusterName)
	}
	// (2) ClusterReady == true proves WaitClusterReady + WaitPodToAPIServer actually
	//     ran against a real, reachable kind cluster (API answered, a node reached
	//     Ready, and a pod reached the apiserver across the cluster network) — NOT
	//     merely that `tofu apply` exited 0.
	if !result.ClusterReady {
		t.Fatal("ClusterReady is false — WaitClusterReady/WaitPodToAPIServer did not prove a reachable cluster")
	}
	// (3) A signed evidence receipt exists and is sealed to the plan hash.
	if result.VerifyReport == nil {
		t.Fatal("VerifyReport is nil — the verification gate did not run on the plan JSON")
	}
	assertSealedSignedReceipt(t, result.VerifyReceipt, pub)

	// (4) The cluster is INDEPENDENTLY reachable via the EMITTED kubeconfig output
	//     (not just the KUBECONFIG env side-effect): a node reports Ready.
	assertKubeconfigNodesReady(t, result.Outputs)
}

// assertKubeconfigNodesReady writes the emitted `kubeconfig` output to a temp file
// and asserts `kubectl get nodes` reports at least one Ready node — an independent
// proof of reachability that does not rely on the deploy's KUBECONFIG side-effect.
func assertKubeconfigNodesReady(t *testing.T, outputs map[string]interface{}) {
	t.Helper()
	raw, ok := outputs["kubeconfig"].(string)
	if !ok || raw == "" {
		t.Fatalf("no kubeconfig string in outputs (got %T)", outputs["kubeconfig"])
	}
	dir := t.TempDir()
	kc := filepath.Join(dir, "kubeconfig")
	if err := os.WriteFile(kc, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "kubectl", "get", "nodes", "--no-headers")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kc)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get nodes via emitted kubeconfig failed: %v\n%s", err, out)
	}
	if !hasReadyNode(string(out)) {
		t.Fatalf("no Ready node via the emitted kubeconfig:\n%s", out)
	}
	t.Logf("kind nodes via emitted kubeconfig:\n%s", out)
}

// hasReadyNode returns true if any line of `kubectl get nodes --no-headers` output
// has STATUS exactly "Ready" (the 2nd column) — NOT "NotReady", which also contains
// the substring "Ready".
func hasReadyNode(nodes string) bool {
	for _, line := range strings.Split(strings.TrimSpace(nodes), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "Ready" {
			return true
		}
	}
	return false
}
