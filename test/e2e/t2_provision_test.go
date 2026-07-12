// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// T2 — the REAL-CLOUD provisioning proof driven by the REAL runner BINARY.
//
// Build-tagged `e2e_t2` so it is OFF for bare `go test`, every-PR CI, and the
// merge-queue T1 job. It runs ONLY in the nightly `e2e-nightly.yml` workflow, which
// a maintainer opts into by wiring the required cloud secret (e.g. HCLOUD_TOKEN).
//
//	cd test/e2e
//	GOWORK=off go test -tags=e2e_t2 ./... -run TestT2RealCloudProvisioning -v
//
// # Relationship to T1
//
// T1 (t1_provision_test.go) drives the SAME real-runner-claims-from-a-real-control-
// plane pattern against a hermetic local `kind` cluster (no cloud, no cost). T2
// reuses that whole pattern — the Postgres-backed control plane, the atomic claim,
// the status-callback + log-shipping paths, the signed-receipt verification, the
// bounded WaitTerminal — from controlplane.go verbatim, but points the runner at the
// REAL cloud template (infra/templates/project/<provider>) with a real API token, so
// it stands up a genuine ephemeral cluster. It asserts the SAME RunDeployV2 outcomes
// as T1: SUCCESS + cluster_ready + a signed evidence receipt + shipped logs.
//
// # Cost + safety (this test provisions REAL, billable infrastructure)
//
//   - Teardown is GUARANTEED and registered BEFORE the deploy: a t.Cleanup runs the
//     REAL provisioner.RunDestroy (reading state back from the control plane) even on
//     a mid-apply failure. The control plane's state backend is in-memory, so it dies
//     with this process — there is no persisted state to purge.
//   - The in-process RunDestroy is the GRACEFUL teardown. It cannot run if the test
//     PROCESS is hard-killed (a `go test -timeout` panic or a CI step SIGKILL skips
//     t.Cleanup). The nightly workflow therefore ALSO runs a belt-and-suspenders
//     `scripts/e2e/hcloud-cleanup.sh` in an `always()` step that deletes cloud
//     resources by the UNIQUE per-run `cluster` label — independent of this process.
//   - The cluster name is DETERMINISTIC and unique per run: the workflow passes
//     ALETHIA_E2E_PROJECT + ALETHIA_E2E_ENV, so `<project>-<env>` matches EXACTLY the
//     `cluster` label the template stamps on every hcloud resource. The workflow's
//     cleanup filters on that same label — never an account-wide delete (the hcloud
//     account is shared with prod/test clusters; see the scope-destructive-cloud-ops
//     memory).
//
// # How each way this test could go VACUOUS is defeated (mirrors T1)
//
//   - a missing prerequisite (tofu/kubectl/helm) or a missing HCLOUD_TOKEN →
//     ALETHIA_E2E_T2_REQUIRE=1 (set by the nightly) turns it into a HARD FAIL, never
//     a green skip. Off CI it skips cleanly.
//   - the runner never claims → WaitTerminal is a BOUNDED poll; it errors, never
//     blocks forever.
//   - "tofu apply exited 0" masquerading as a working cluster → we assert
//     cluster_name (post-apply spine not skipped) AND cluster_ready==true (the
//     runner's reachability gate proved a live API + Ready node + pod datapath).
//   - a nil/empty receipt → we require a signed receipt sealed to the real plan
//     sha256 whose ed25519 signature verifies under our pub.
//   - in-process-only work → we assert a status callback reached `jobs` and log lines
//     reached `job_logs` over the real HTTP paths.
package e2e

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestT2RealCloudProvisioning stands up a real ephemeral cluster on a real cloud via
// the real runner binary claiming a real DEPLOY job, asserts the RunDeployV2 spine
// succeeded, and guarantees teardown. Maintainer-gated: it only does real work when
// the cloud token + tools are present (a HARD FAIL under ALETHIA_E2E_T2_REQUIRE).
func TestT2RealCloudProvisioning(t *testing.T) {
	// Provider (only hetzner today; aws/azure slot in behind their own token env).
	provider := t2Env("ALETHIA_E2E_PROVIDER", "hetzner")
	if provider != "hetzner" {
		t.Fatalf("T2 currently supports only provider=hetzner, got %q", provider)
	}

	// Prerequisites: the real spine shells out to these, plus a migrated control-plane
	// Postgres and the cloud token. (No `kind` — this is a real cloud, not local.)
	for _, bin := range []string{"tofu", "kubectl", "helm", "go"} {
		t2RequireOrSkip(t, t2HaveBin(bin), bin+" not on PATH")
	}
	dbURL := os.Getenv("ALETHIA_DATABASE_URL")
	t2RequireOrSkip(t, dbURL != "", "ALETHIA_DATABASE_URL is unset (the migrated control-plane DB)")
	hcloudToken := os.Getenv("HCLOUD_TOKEN")
	t2RequireOrSkip(t, hcloudToken != "", "HCLOUD_TOKEN is unset (the hetzner API token from repo secrets)")

	root := t2RepoRoot(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	// ── The cluster identity is DETERMINISTIC + unique per run. The workflow passes
	// these (derived from the GitHub run id/attempt) and feeds the SAME
	// `<project>-<env>` to the belt-and-suspenders cleanup, so the label filter is an
	// exact match. A random fallback keeps a local invocation safe (never a bare or
	// shared name that a broad delete could catch). ──
	project := t2Env("ALETHIA_E2E_PROJECT", "alethia-nl")
	env := t2Env("ALETHIA_E2E_ENV", "local"+t2ShortHex(t))
	region := t2Env("ALETHIA_E2E_HCLOUD_REGION", "nbg1")
	clusterName := project + "-" + env
	t.Logf("T2 target: provider=%s region=%s cluster=%s", provider, region, clusterName)

	// ── Build the REAL runner binary (this is what makes it a spine proof, not a unit
	// test) — identical to T1. ──
	runnerBin := filepath.Join(t.TempDir(), "alethia-runner")
	t2BuildRunner(t, root, runnerBin)

	// ── Stage the REAL cloud template so the runner resolves
	// `project-templates/<provider>` from its CWD. Unlike T1 (which stages the LOCAL
	// kind module as "hetzner"), we stage the genuine cloud template verbatim. ──
	stage := t.TempDir()
	realTemplateSrc := filepath.Join(root, "infra", "templates", "project", provider)
	stagedTemplate := filepath.Join(stage, "project-templates", provider)
	t2CopyTree(t, realTemplateSrc, stagedTemplate)

	// ── Receipt signing key: runner gets the private half; we keep pub to VERIFY. ──
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}

	// ── Real control plane over real Postgres (reused verbatim from controlplane.go). ──
	cp, err := NewControlPlane(ctx, dbURL)
	if err != nil {
		t.Fatalf("control plane: %v", err)
	}
	runnerID, runnerToken, err := cp.SeedRunner(ctx)
	if err != nil {
		t.Fatalf("seed runner: %v", err)
	}
	cp.Start()
	// LIFO: Close registered FIRST so it runs LAST — after teardown, which reads state
	// over HTTP from this same server.
	t.Cleanup(cp.Close)

	jobID, err := seedT2DeployJob(ctx, cp, project, env, provider, region)
	if err != nil {
		t.Fatalf("seed job: %v", err)
	}
	t.Logf("seeded QUEUED DEPLOY job %s targeting %s template (cluster %s)", jobID, provider, clusterName)

	// GUARANTEED graceful teardown — registered BEFORE launching the runner so a
	// mid-deploy failure still tears the cluster down. The workflow's always() cleanup
	// is the hard guarantee for a killed process; this is the in-process best effort.
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer dcancel()
		if derr := teardownT2Cluster(dctx, cp.URL(), jobID, project, env, provider, region, stagedTemplate, t2LogWriter{t}); derr != nil {
			t.Logf("teardown RunDestroy failed (workflow hcloud-cleanup is the guarantee): %v", derr)
		} else {
			t.Log("teardown: cluster destroyed via RunDestroy")
		}
	})

	// ── Launch the REAL runner process pointed at the control plane, with the cloud
	// token in its environment. cloud_identity is nil (like T1), so the runner does no
	// credential activation and the hcloud/imager/talos providers read HCLOUD_TOKEN
	// straight from this env — the self-managed / ambient-token path. ──
	var runnerOut bytes.Buffer
	runnerCtx, killRunner := context.WithCancel(ctx)
	defer killRunner()
	cmd := exec.CommandContext(runnerCtx, runnerBin)
	cmd.Dir = stage
	cmd.Env = append(os.Environ(),
		"ALETHIA_WEB_ORIGIN="+cp.URL(),
		"ALETHIA_RUNNER_ID="+runnerID,
		"ALETHIA_RUNNER_TOKEN="+runnerToken,
		"ALETHIA_RUNNER_OPERATOR=self",
		"HCLOUD_TOKEN="+hcloudToken,
		"ALETHIA_RECEIPT_SIGNING_KEY="+base64.StdEncoding.EncodeToString(priv),
		"ALETHIA_CLUSTER_READY_TIMEOUT="+t2ClusterReadyTimeout(),
		"ALETHIA_ARGOCD_TEMPLATES_DIR="+filepath.Join(root, "infra", "templates", "argocd"),
	)
	var runnerSink io.Writer = &runnerOut
	if p := os.Getenv("ALETHIA_E2E_T2_RUNNER_LOG"); p != "" {
		if f, ferr := os.Create(p); ferr == nil {
			t.Cleanup(func() { _ = f.Close() })
			runnerSink = io.MultiWriter(&runnerOut, f)
		}
	}
	cmd.Stdout = runnerSink
	cmd.Stderr = runnerSink
	if err := cmd.Start(); err != nil {
		t.Fatalf("start runner process: %v", err)
	}
	t.Cleanup(func() {
		killRunner()
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("──── runner process output ────\n%s", runnerOut.String())
		}
	})

	// ── Wait (bounded) for the job to go terminal, then assert on the REAL DB rows. ──
	status, err := cp.WaitTerminal(ctx, jobID, t2WaitTimeout())
	if err != nil {
		t.Fatalf("waiting for job to finish: %v\n──── runner output ────\n%s", err, runnerOut.String())
	}
	if status != "SUCCESS" {
		t.Fatalf("job terminal status = %q, want SUCCESS\n──── runner output ────\n%s", status, runnerOut.String())
	}

	_, metaRaw, err := cp.JobState(ctx, jobID)
	if err != nil {
		t.Fatalf("read job metadata: %v", err)
	}
	if len(metaRaw) == 0 {
		t.Fatal("job execution_metadata is empty — no status callback carried the post-apply result")
	}
	var meta struct {
		ClusterName   string          `json:"cluster_name"`
		ClusterReady  bool            `json:"cluster_ready"`
		VerifyReceipt json.RawMessage `json:"verify_receipt"`
		VerifyResult  json.RawMessage `json:"verify_result"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("decode execution_metadata: %v\nraw: %s", err, metaRaw)
	}

	// (1) ClusterName present + correct ⇒ the post-apply spine ran (it is gated on the
	//     talos_cluster_name output) AND matches the unique name we asked for.
	if meta.ClusterName == "" {
		t.Fatal("cluster_name is empty in metadata — the post-apply spine was SKIPPED")
	}
	if meta.ClusterName != clusterName {
		t.Fatalf("cluster_name = %q, want %q", meta.ClusterName, clusterName)
	}
	// (2) cluster_ready ⇒ the reachability gate proved a live cluster, not just apply=0.
	if !meta.ClusterReady {
		t.Fatal("cluster_ready is not true — the reachability gate did not pass")
	}
	// (3) A signed evidence receipt, sealed to the real plan hash + verifying under pub.
	if len(meta.VerifyResult) == 0 {
		t.Fatal("verify_result is absent — the verification gate did not run on the plan JSON")
	}
	planSHA, err := VerifySignedReceipt(meta.VerifyReceipt, pub)
	if err != nil {
		t.Fatalf("signed receipt assertion: %v", err)
	}
	t.Logf("verified signed receipt sealed to plan sha256 %s", planSHA)

	// (4) The claim/callback/log-shipping paths reached the DB.
	logCount, logContent, err := cp.JobLogs(ctx, jobID)
	if err != nil {
		t.Fatalf("read job logs: %v", err)
	}
	if logCount == 0 {
		t.Fatal("no job_logs rows — the runner's log-shipping path did not reach the DB")
	}
	if !strings.Contains(logContent, "Job claimed") {
		t.Fatalf("shipped logs missing the claim banner — got %d lines:\n%s", logCount, t2Truncate(logContent, 2000))
	}
	t.Logf("%d log lines shipped to job_logs", logCount)

	// (5) INDEPENDENT reachability: the runner wrote a host-usable kubeconfig to
	//     $HOME/.alethia/kubeconfig (ConfigureKubeconfig). Read it and prove a node is
	//     Ready via a fresh kubectl — the workflow's capture-e1.sh reuses this same
	//     kubeconfig for the committed proof.
	assertT2KubeconfigNodesReady(t, ctx)
}

// assertT2KubeconfigNodesReady reads the runner-written kubeconfig and asserts at
// least one Ready node via a fresh kubectl. (For a real cloud the kubeconfig is a
// Talos output the runner persisted, not a `kind` side-effect — so we read it from
// $HOME/.alethia/kubeconfig rather than shelling `kind get kubeconfig`.)
func assertT2KubeconfigNodesReady(t *testing.T, ctx context.Context) {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.TempDir()
	}
	kc := filepath.Join(home, ".alethia", "kubeconfig")
	if _, err := os.Stat(kc); err != nil {
		t.Fatalf("runner kubeconfig not found at %s: %v", kc, err)
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "get", "nodes", "--no-headers")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kc)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get nodes via runner kubeconfig failed: %v\n%s", err, out)
	}
	if !HasReadyNode(string(out)) {
		t.Fatalf("no Ready node via the runner kubeconfig:\n%s", out)
	}
	t.Logf("kubectl get nodes:\n%s", out)
}

// seedT2DeployJob enqueues a QUEUED DEPLOY job whose config_snapshot targets the REAL
// cloud template at a REAL region. The `provider` column is left NULL so the atomic
// claim's provider filter passes for the seeded runner; the runner reads the provider
// from the snapshot. Node sizing is left at the template default (1 control plane + 1
// worker) — the cheapest cluster. Reuses the control plane's own pool (same package).
func seedT2DeployJob(ctx context.Context, cp *ControlPlane, project, env, provider, region string) (string, error) {
	jobID := newUUID()
	snapshot, err := json.Marshal(map[string]any{
		"id":                "e2e-" + env,
		"project_name":      project,
		"environment_stage": env,
		"region":            region,
		"provider":          provider,
	})
	if err != nil {
		return "", err
	}
	_, err = cp.pool.Exec(ctx, `
		INSERT INTO public.jobs
		  (id, user_id, org_id, job_type, config_snapshot, status, provider)
		VALUES ($1, $2, $2, 'DEPLOY', $3::jsonb, 'QUEUED', NULL)`,
		jobID, newUUID(), string(snapshot))
	if err != nil {
		return "", fmt.Errorf("seed job: %w", err)
	}
	return jobID, nil
}

// teardownT2Cluster destroys the provisioned cloud cluster via the REAL provisioner
// RunDestroy, reading state back from the control plane. It reconstructs the SAME
// ProjectConfig (project/env/region) the deploy used so ProviderTfvars resolves the
// same variables. GUARANTEED: the caller registers it before the deploy. There is no
// docker-rm fallback (that is a kind-only concept); the workflow's hcloud-cleanup.sh
// is the belt-and-suspenders for real cloud resources.
func teardownT2Cluster(ctx context.Context, cpURL, jobID, project, env, provider, region, templatesDir string, out io.Writer) error {
	vc := &types.ProjectConfig{
		ID:               "e2e-" + env,
		ProjectName:      project,
		EnvironmentStage: env,
		Region:           region,
	}
	backend := &cloud.HTTPBackendConfig{ConsoleURL: cpURL, JobID: jobID, Token: "e2e-teardown"}
	return provisioner.RunDestroy(ctx, provisioner.DestroyParams{
		ProjectConfig: vc,
		Provider:      provider,
		TemplatesDir:  templatesDir,
		StateBackend:  backend,
		Stdout:        out,
		Stderr:        out,
	})
}

// ─────────────────────────── T2-local helpers ───────────────────────────
// These mirror the T1 helpers but are redefined here (the t1 file is under a
// DIFFERENT build tag, so its symbols are not compiled with this file). They are
// prefixed `t2` to stay collision-free even under `-tags "e2e_t1 e2e_t2"`.

// t2RequireOrSkip enforces a prerequisite: a HARD FAIL under ALETHIA_E2E_T2_REQUIRE
// (the nightly sets it), a clean skip otherwise — so a broken environment never
// masquerades as a green skip in CI, and a dev laptop is not forced to have a token.
func t2RequireOrSkip(t *testing.T, cond bool, msg string) {
	t.Helper()
	if cond {
		return
	}
	if t2Truthy(os.Getenv("ALETHIA_E2E_T2_REQUIRE")) {
		t.Fatalf("T2 prerequisite missing (ALETHIA_E2E_T2_REQUIRE set): %s", msg)
	}
	t.Skipf("T2 prerequisite missing: %s", msg)
}

func t2Truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func t2Env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func t2HaveBin(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// t2RepoRoot resolves the repository root relative to THIS file (test/e2e/<file>).
func t2RepoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	rootDir, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return rootDir
}

// t2BuildRunner compiles the real runner binary from apps/runner/cmd/runner in
// workspace mode (the repo go.work), exactly like the `go` CI job resolves it.
func t2BuildRunner(t *testing.T, root, outBin string) {
	t.Helper()
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, "go", "build", "-o", outBin, "./cmd/runner")
	cmd.Dir = filepath.Join(root, "apps", "runner")
	cmd.Env = append(os.Environ(), "GOWORK="+filepath.Join(root, "go.work"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build runner binary: %v\n%s", err, out)
	}
}

// t2CopyTree recursively copies a template directory (the cloud templates are flat
// today, but copy recursively so a future sub-module template still stages cleanly).
func t2CopyTree(t *testing.T, src, dst string) {
	t.Helper()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatalf("read template dir: %v", err)
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			t2CopyTree(t, s, d)
			continue
		}
		b, err := os.ReadFile(s)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(d, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// t2ClusterReadyTimeout is the runner's reachability-gate timeout — a real cloud is
// slower to boot than kind, so 8m by default (overridable for a slow account).
func t2ClusterReadyTimeout() string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_TIMEOUT")); v != "" {
		return v
	}
	return "8m"
}

// t2WaitTimeout bounds how long the test waits for the job to finish (image build +
// apply + spine + argo on real infra). Generous but finite.
func t2WaitTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_T2_WAIT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return 25 * time.Minute
}

func t2ShortHex(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func t2Truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(truncated)"
}

// t2LogWriter pipes provisioner teardown output into the test log.
type t2LogWriter struct{ t *testing.T }

func (w t2LogWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", bytes.TrimRight(p, "\n"))
	return len(p), nil
}
