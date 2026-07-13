// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_local

// BYO IaC (bring-your-own OpenTofu) provisioning-E2E — BYOC Program task B5.2.
//
// This is the T1-style, `kind`-backed proof that the FULL bring-your-own-IaC lifecycle
// works end to end against a genuine local Kubernetes-IN-Docker cluster, with NO cloud
// account and NO cloud credentials:
//
//	attach  → IAC_SCAN pins the git SHA
//	        → replace-mode DEPLOY applies the customer's own module (pinned commit)
//	        → tofu state lands on the console HTTP state proxy (asserted in-process,
//	          never persisted to the runner's local disk)
//	        → DETECT_DRIFT reports in_sync
//	        → DESTROY tears the cluster down + clears proxy state
//	        → detach becomes safe (no live state)
//
// plus the two adversarial cases the task calls out:
//
//	TOCTOU (TestE2EByoIacTOCTOUPinnedCommit): the deploy checks out the PINNED commit,
//	  not the moving ref — a commit pushed AFTER the scan pinned a SHA never applies.
//	attach-over-live-state: enforced in the console DB layer (attachIacSource rejects an
//	  env that already holds template/BYO state); proven in apps/console's byo-iac.test.ts
//	  (this Go tier cannot reach the TS console — see the PR body for why).
//
// # Why this lives in packages/core/provisioner (and not test/e2e)
//
// The BYO deploy/drift/destroy path rejects a `file://` repo_url at the untrusted
// boundary (validateByoRepoURL); only the in-package test escape `allowInsecureRepoURLForTest`
// re-admits it for a local git fixture. That escape is an UNEXPORTED package var, so a
// hermetic BYO e2e over a local fixture must live INSIDE this package. The separate-binary
// T1 in test/e2e would need a real https/ssh git server to drive the BYO path — a follow-up.
// This test still drives the REAL provisioner spine (real tofu init/plan/apply/refresh/
// destroy, real iacsafety gate, real HTTP state backend, real kind cluster), which is the
// BYO-specific risk surface end to end.
//
// # How each way this could go VACUOUS is defeated
//
//   - "the scan rubber-stamped the module" → we assert the SAME module is BLOCKED under the
//     DEFAULT allowlist (tehcyx/kind absent) and only passes once the operator allowlists it,
//     and that the scan actually parsed a provider (len(Providers) > 0) and pinned a real
//     40-hex commit matching the fixture HEAD.
//   - "the deploy never reached apply / tofu exited 0 but nothing exists" → we independently
//     prove a Ready node via the module's emitted kubeconfig output AND that `kind get clusters`
//     lists the cluster.
//   - "state was on local disk, not the proxy" → the module declares NO backend; the platform
//     override forces the http backend. A recording state server proves state was POSTed to the
//     proxy AND that drift/destroy (fresh clones, empty local workdir) read it back to run.
//   - "drift was never computed" → we assert a non-nil posture with Drifted==0 AND InSync.
//   - "the pinned SHA didn't matter (both commits identical)" → the TOCTOU test proves the
//     post-scan commit genuinely differs by applying it separately and observing its injected
//     output, then proves the pinned deploy did NOT carry that output.
package provisioner

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/iacsafety"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ─────────────────────────── recording state proxy ───────────────────────────

// recordingStateServer is an in-memory OpenTofu `http` state backend (exactly what
// cloud.HTTPBackendConfig points tofu at) that RECORDS the last state body + POST/DELETE
// counts, so the test can assert state landed on the proxy (and was later cleared) — the
// "state on the proxy, never persisted to disk" invariant. Same wire contract as the
// package's startTestStateServer, plus introspection.
type recordingStateServer struct {
	mu        sync.Mutex
	state     []byte
	haveState bool
	posts     int
	deletes   int
	srv       *httptest.Server
}

func startRecordingStateServer(t *testing.T) *recordingStateServer {
	t.Helper()
	rs := &recordingStateServer{}
	rs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.mu.Lock()
		defer rs.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/lock"):
			w.WriteHeader(http.StatusOK) // single-writer test always acquires
		case r.Method == http.MethodGet:
			if !rs.haveState {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(rs.state)
		case r.Method == http.MethodPost:
			b, _ := io.ReadAll(r.Body)
			rs.state = b
			rs.haveState = true
			rs.posts++
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodDelete:
			rs.state, rs.haveState = nil, false
			rs.deletes++
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(rs.srv.Close)
	return rs
}

func (rs *recordingStateServer) backend(jobID string) *cloud.HTTPBackendConfig {
	return &cloud.HTTPBackendConfig{ConsoleURL: rs.srv.URL, JobID: jobID, Token: "byo-e2e-token"}
}

func (rs *recordingStateServer) snapshot() (state []byte, have bool, posts, deletes int) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	cp := make([]byte, len(rs.state))
	copy(cp, rs.state)
	return cp, rs.haveState, rs.posts, rs.deletes
}

// ─────────────────────────── git fixtures ───────────────────────────

// gitEnv is the hermetic git environment: no global/system config, a fixed identity.
func gitEnv() []string {
	return append(os.Environ(),
		"GIT_AUTHOR_NAME=byo", "GIT_AUTHOR_EMAIL=byo@e.com",
		"GIT_COMMITTER_NAME=byo", "GIT_COMMITTER_EMAIL=byo@e.com",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
}

// gitRun runs a git subcommand in dir and returns trimmed stdout (fatal on error).
func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// initRepoWithModule creates a git repo whose `moduleSub/` directory holds `files`
// (name→content), commits, and returns (repoDir, branch, commitSHA). A customer BYO
// repo — the runner clones it at the pinned commit.
func initRepoWithModule(t *testing.T, moduleSub string, files map[string]string) (repo, branch, sha string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	repo = t.TempDir()
	gitRun(t, repo, "init", "-q")
	writeModuleFiles(t, repo, moduleSub, files)
	gitRun(t, repo, "add", ".")
	gitRun(t, repo, "commit", "-q", "-m", "initial module")
	sha = gitRun(t, repo, "rev-parse", "HEAD")
	branch = gitRun(t, repo, "rev-parse", "--abbrev-ref", "HEAD")
	return repo, branch, sha
}

// commitModuleChange overwrites `moduleSub/` with `files` and commits, returning the new
// HEAD SHA — used to advance the branch AFTER a scan pinned an earlier commit (TOCTOU).
func commitModuleChange(t *testing.T, repo, moduleSub string, files map[string]string, msg string) string {
	t.Helper()
	writeModuleFiles(t, repo, moduleSub, files)
	gitRun(t, repo, "add", ".")
	gitRun(t, repo, "commit", "-q", "-m", msg)
	return gitRun(t, repo, "rev-parse", "HEAD")
}

func writeModuleFiles(t *testing.T, repo, moduleSub string, files map[string]string) {
	t.Helper()
	dir := filepath.Join(repo, moduleSub)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// ─────────────────────────── the BYO kind module ───────────────────────────

// byoKindModuleTF is a CUSTOMER-authored BYO root module: a single tehcyx/kind cluster
// named from the FROZEN Alethia context contract (TF_VAR_alethia_project /
// _environment, published by prepareByoIacWorkdir — so a green run also proves that
// contract reaches the customer module). It declares NO backend (the platform override
// forces the http state proxy) and emits GENERIC (non-talos_) outputs, so
// cloud.ExtractClusterName returns "" and the Alethia post-apply spine is correctly
// SKIPPED — exactly the BYO semantics (the customer owns their own resource graph).
const byoKindModuleTF = `terraform {
  required_version = ">= 1.6"
  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "0.11.0"
    }
  }
}

provider "kind" {}

variable "alethia_project" {
  type    = string
  default = "byo"
}

variable "alethia_environment" {
  type    = string
  default = "env"
}

locals {
  cluster_name = "${var.alethia_project}-${var.alethia_environment}"
}

resource "kind_cluster" "this" {
  name           = local.cluster_name
  wait_for_ready = true
}

output "byo_cluster_name" {
  value = local.cluster_name
}

output "byo_kubeconfig" {
  value     = kind_cluster.this.kubeconfig
  sensitive = true
}
`

// TestE2EByoIacLifecycleKind is the flagship: the whole BYO IaC lifecycle against a real
// kind cluster driven through the real provisioner spine.
func TestE2EByoIacLifecycleKind(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping the BYO IaC kind E2E")
	}
	requireDockerOrSkip(t)

	// Operator allowlists the kind provider for BYO on this instance. Read by BOTH the
	// explicit scan below AND the deploy/drift/destroy inline fail-closed gates
	// (iacsafety.AllowlistFromEnv). Without it the module is BLOCKED — asserted below.
	t.Setenv(iacsafety.AllowlistEnvVar, "tehcyx/kind")
	// A local file:// fixture is only admissible with the in-package test escape. Reset it
	// via t.Cleanup (registered FIRST ⇒ runs LAST, LIFO) so the guaranteed-teardown clone
	// below — registered later ⇒ runs earlier — still sees the escape enabled.
	allowInsecureRepoURLForTest = true
	t.Cleanup(func() { allowInsecureRepoURLForTest = false })
	// Fail fast if the cluster is broken (the post-apply spine is skipped for BYO, so this
	// is only a floor for any tofu-side waits).
	t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "3m")

	// Sign the evidence receipt so we can assert it's sealed AND verifies (BYO plans get a
	// receipt too — the verify gate runs on the plan JSON before apply).
	priv, pub := genEd25519(t)
	t.Setenv("ALETHIA_RECEIPT_SIGNING_KEY", base64.StdEncoding.EncodeToString(priv))

	moduleSub := "stack"
	repo, branch, headSHA := initRepoWithModule(t, moduleSub, map[string]string{"main.tf": byoKindModuleTF})
	repoURL := "file://" + repo

	// ── (1) ATTACH → IAC_SCAN pins the SHA. Mirror the runner's executeIacScan core:
	// clone at the ref, resolve HEAD, run the fail-closed static gate. The pinned SHA is
	// what the console's finalizeIacScan writes back onto the row — and what the DEPLOY
	// below actually applies (the writeback→deploy handoff). ──
	scanClone := filepath.Join(t.TempDir(), "scan-clone")
	sg := git.NewGIT(repoURL, scanClone, false)
	if err := sg.Clone(branch, true); err != nil {
		t.Fatalf("scan clone: %v", err)
	}
	pinnedSHA, err := sg.HeadSHA()
	if err != nil {
		t.Fatalf("resolve HEAD (scan pin): %v", err)
	}
	if len(pinnedSHA) != 40 || pinnedSHA != headSHA {
		t.Fatalf("scan pinned SHA %q (len %d), want the fixture HEAD %q", pinnedSHA, len(pinnedSHA), headSHA)
	}
	scanModuleDir := filepath.Join(scanClone, moduleSub)

	// Gate REALLY ran: the same module BLOCKS under the default allowlist (tehcyx/kind
	// absent) and only passes once allowlisted, and the scan parsed a real provider.
	blocked, err := iacsafety.Scan(scanModuleDir, iacsafety.DefaultProviderAllowlist())
	if err != nil {
		t.Fatalf("iacsafety scan (default allowlist): %v", err)
	}
	if blocked.OK {
		t.Fatal("BYO kind module PASSED the default allowlist — the gate is vacuous (tehcyx/kind must be blocked unless allowlisted)")
	}
	if !hasFinding(blocked, iacsafety.RuleProviderNotAllowlisted, "tehcyx/kind") {
		t.Fatalf("expected a provider-not-allowlisted error naming tehcyx/kind, got findings: %+v", blocked.Findings)
	}
	report, err := iacsafety.Scan(scanModuleDir, []string{"tehcyx/kind"})
	if err != nil {
		t.Fatalf("iacsafety scan (kind allowlisted): %v", err)
	}
	if !report.OK {
		t.Fatalf("BYO kind module should PASS once tehcyx/kind is allowlisted; findings: %+v", report.Findings)
	}
	if len(report.Providers) == 0 || !contains(report.Providers, "tehcyx/kind") {
		t.Fatalf("scan did not evaluate the kind provider (Providers=%v) — gate may be vacuous", report.Providers)
	}
	t.Logf("IAC_SCAN pinned commit %s; providers=%v (blocked under default allowlist, ok once allowlisted)", pinnedSHA, report.Providers)

	// ── The attached source the console would persist + the config snapshot a DEPLOY
	// carries: pinned commit_sha (from the scan writeback), the moving ref, the module path. ──
	env := "e2e" + shortID(t)
	vc := &types.ProjectConfig{
		ID:               "byo-" + env,
		ProjectName:      "byoiac",
		EnvironmentStage: env,
		Region:           "local",
		IacSource: &types.ProjectIacSourceConfig{
			RepoURL:   repoURL,
			Ref:       branch,
			Path:      moduleSub,
			CommitSHA: pinnedSHA, // what the scan pinned — NOT the moving ref
		},
	}
	clusterName := vc.ProjectName + "-" + vc.EnvironmentStage
	rs := startRecordingStateServer(t)
	logw := tLogWriter{t}

	// GUARANTEED teardown BEFORE the deploy: real BYO RunDestroy (pinned commit), with a
	// docker-level fallback so no kind container leaks if `tofu destroy` fails.
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer dcancel()
		if derr := RunDestroy(dctx, DestroyParams{
			ProjectConfig: vc,
			Provider:      "hetzner", // BYO path keys on IacSource, not the provider enum
			StateBackend:  rs.backend("byo-" + env),
			Stdout:        logw,
			Stderr:        logw,
		}); derr != nil {
			t.Logf("BYO RunDestroy cleanup failed (%v) — docker rm fallback", derr)
			_ = exec.Command("docker", "rm", "-f", clusterName+"-control-plane").Run()
		}
	})

	// ── (2) replace-mode DEPLOY: the customer's own module at the pinned commit. ──
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	result, err := RunDeployV2(ctx, DeployParams{
		ProjectConfig: vc,
		Provider:      "hetzner",
		StateBackend:  rs.backend("byo-" + env),
		DryRun:        false,
		Stdout:        logw,
		Stderr:        logw,
	})
	if err != nil {
		t.Fatalf("BYO RunDeployV2 against kind: %v", err)
	}

	// BYO semantics: a customer module emits no talos_* output, so ExtractClusterName is
	// "" and the Alethia post-apply spine (kubeconfig/argocd/addons) is correctly SKIPPED.
	if result.ClusterName != "" {
		t.Fatalf("BYO deploy set ClusterName=%q — the Alethia post-apply spine should be skipped for a customer module", result.ClusterName)
	}
	if result.ClusterReady {
		t.Fatal("BYO deploy set ClusterReady — the Alethia reachability gate must not run for a customer module")
	}
	// The verify gate + signed evidence receipt still fired on the plan JSON.
	if result.VerifyReport == nil {
		t.Fatal("VerifyReport is nil — the verification gate did not run on the BYO plan JSON")
	}
	assertSealedSignedReceipt(t, result.VerifyReceipt, pub)

	// ── (3) state on the proxy, NOT persisted locally. The module declares no backend;
	// the platform override forced the http proxy. The recording server proves state was
	// POSTed there and carries the real kind resource. ──
	stateBytes, have, posts, _ := rs.snapshot()
	if !have || posts == 0 {
		t.Fatalf("no state POSTed to the proxy (have=%v posts=%d) — the http backend override did not take effect (state may be on local disk)", have, posts)
	}
	if !strings.Contains(string(stateBytes), "kind_cluster") || !strings.Contains(string(stateBytes), clusterName) {
		t.Fatalf("proxy state does not contain the applied kind_cluster/%s — apply may not have written real state:\n%s", clusterName, truncateState(stateBytes))
	}
	t.Logf("proxy holds %d bytes of tofu state after %d POST(s), containing kind_cluster/%s", len(stateBytes), posts, clusterName)

	// ── (4) independent proof the cluster is REALLY up: a Ready node via the module's
	// emitted kubeconfig output (not a side-effect), and `kind get clusters` lists it. ──
	assertByoKubeconfigReady(t, result.Outputs)
	assertKindClusterListed(t, ctx, clusterName)

	// ── (5) DETECT_DRIFT → in_sync (nothing changed since apply). ──
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Minute)
	defer dcancel()
	posture, _, err := RunDriftDetection(dctx, DriftParams{
		ProjectConfig: vc,
		Provider:      "hetzner",
		StateBackend:  rs.backend("byo-" + env),
		Stdout:        logw,
		Stderr:        logw,
	})
	if err != nil {
		t.Fatalf("BYO RunDriftDetection: %v", err)
	}
	if posture == nil {
		t.Fatal("drift posture is nil — refresh-only drift did not run")
	}
	if !posture.InSync || posture.Drifted != 0 {
		t.Fatalf("expected in_sync drift immediately after apply, got InSync=%v drifted=%d details=%+v",
			posture.InSync, posture.Drifted, posture.Details)
	}
	t.Logf("drift posture: %s", posture.Summary())

	// ── (6) DESTROY → cluster gone + proxy state cleared (⇒ detach is now safe). ──
	xctx, xcancel := context.WithTimeout(ctx, 5*time.Minute)
	defer xcancel()
	if err := RunDestroy(xctx, DestroyParams{
		ProjectConfig: vc,
		Provider:      "hetzner",
		StateBackend:  rs.backend("byo-" + env),
		Stdout:        logw,
		Stderr:        logw,
	}); err != nil {
		t.Fatalf("BYO RunDestroy: %v", err)
	}
	assertKindClusterGone(t, ctx, clusterName)
	// The console guards detach on live state (deployed_commit_sha / active status). Its
	// provisioner-observable analog: destroy emptied the state on the proxy (OpenTofu's http
	// backend rewrites an empty state on destroy rather than DELETE-ing it), so no live BYO
	// resource is left to orphan — detach is safe. Assert the post-destroy proxy state no
	// longer references the kind cluster (its resources array is now empty).
	postState, postHave, _, _ := rs.snapshot()
	if !postHave {
		t.Fatal("proxy has no state object after destroy — expected an emptied state, not a missing one")
	}
	if strings.Contains(string(postState), "kind_cluster") || strings.Contains(string(postState), clusterName) {
		t.Fatalf("post-destroy proxy state still references the kind cluster — destroy did not clear managed resources:\n%s", truncateState(postState))
	}
	t.Log("BYO IaC lifecycle proven: scan-pin → deploy → state-on-proxy → in_sync drift → destroy → detach-safe")
}

// TestE2EByoIacTOCTOUPinnedCommit proves the pinned-commit checkout defeats a moved ref:
// a commit pushed to the branch AFTER the scan pinned an earlier SHA never applies.
// Docker-free (terraform_data) so it runs anywhere `tofu` is present.
func TestE2EByoIacTOCTOUPinnedCommit(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping the BYO IaC TOCTOU E2E")
	}
	allowInsecureRepoURLForTest = true
	defer func() { allowInsecureRepoURLForTest = false }()

	moduleSub := "stack"
	// v1 (the scanned + pinned commit): a benign marker, no `pwned` output.
	benign := map[string]string{"main.tf": `terraform {
  required_version = ">= 1.6"
}

resource "terraform_data" "marker" {
  input = "v1"
}

output "marker" {
  value = terraform_data.marker.output
}
`}
	repo, branch, pinnedSHA := initRepoWithModule(t, moduleSub, benign)
	repoURL := "file://" + repo

	// ── The attacker advances the SAME branch AFTER the scan pinned pinnedSHA: v2 injects
	// a `pwned` output. This is now the branch HEAD (the moving ref). ──
	malicious := map[string]string{"main.tf": `terraform {
  required_version = ">= 1.6"
}

resource "terraform_data" "marker" {
  input = "v1"
}

output "marker" {
  value = terraform_data.marker.output
}

output "pwned" {
  value = "yes"
}
`}
	movedSHA := commitModuleChange(t, repo, moduleSub, malicious, "attacker: inject pwned output")
	if movedSHA == pinnedSHA {
		t.Fatal("fixture bug: the second commit did not change HEAD")
	}
	if gitRun(t, repo, "rev-parse", branch) != movedSHA {
		t.Fatalf("branch %s should point at the moved commit %s", branch, movedSHA)
	}

	logw := tLogWriter{t}

	// ── Deploy A: Ref points at the moved commit, but CommitSHA is the PINNED one. The
	// deploy MUST apply the pinned bytes → no `pwned` output. ──
	rsA := startRecordingStateServer(t)
	envA := "toctou" + shortID(t)
	vcA := &types.ProjectConfig{
		ID: "byo-" + envA, ProjectName: "byotoctou", EnvironmentStage: envA, Region: "local",
		IacSource: &types.ProjectIacSourceConfig{
			RepoURL: repoURL, Ref: branch, Path: moduleSub, CommitSHA: pinnedSHA,
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer dcancel()
		_ = RunDestroy(dctx, DestroyParams{ProjectConfig: vcA, Provider: "hetzner", StateBackend: rsA.backend("byo-" + envA), Stdout: logw, Stderr: logw})
	})
	resA, err := RunDeployV2(ctx, DeployParams{
		ProjectConfig: vcA, Provider: "hetzner", StateBackend: rsA.backend("byo-" + envA),
		DryRun: false, Stdout: logw, Stderr: logw,
	})
	if err != nil {
		t.Fatalf("TOCTOU deploy A (pinned commit): %v", err)
	}
	if got := outputString(resA.Outputs, "marker"); got != "v1" {
		t.Fatalf("pinned deploy marker=%q, want \"v1\" (the pinned commit's module)", got)
	}
	if _, present := resA.Outputs["pwned"]; present {
		t.Fatalf("PINNED deploy carried the attacker's `pwned` output — the moved ref was applied instead of the pinned commit (TOCTOU regression)")
	}
	// State-on-proxy for a backend-less module = the override forced the http proxy.
	if _, have, posts, _ := rsA.snapshot(); !have || posts == 0 {
		t.Fatal("TOCTOU deploy A wrote no state to the proxy — backend override did not take effect")
	}

	// ── Non-vacuous: the moved commit GENUINELY differs — applying it (CommitSHA=movedSHA)
	// DOES inject `pwned`. So Deploy A's absence of `pwned` is a real TOCTOU defense, not
	// two identical commits. ──
	rsB := startRecordingStateServer(t)
	envB := "moved" + shortID(t)
	vcB := &types.ProjectConfig{
		ID: "byo-" + envB, ProjectName: "byomoved", EnvironmentStage: envB, Region: "local",
		IacSource: &types.ProjectIacSourceConfig{
			RepoURL: repoURL, Ref: branch, Path: moduleSub, CommitSHA: movedSHA,
		},
	}
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer dcancel()
		_ = RunDestroy(dctx, DestroyParams{ProjectConfig: vcB, Provider: "hetzner", StateBackend: rsB.backend("byo-" + envB), Stdout: logw, Stderr: logw})
	})
	resB, err := RunDeployV2(ctx, DeployParams{
		ProjectConfig: vcB, Provider: "hetzner", StateBackend: rsB.backend("byo-" + envB),
		DryRun: false, Stdout: logw, Stderr: logw,
	})
	if err != nil {
		t.Fatalf("TOCTOU deploy B (moved commit): %v", err)
	}
	if got := outputString(resB.Outputs, "pwned"); got != "yes" {
		t.Fatalf("moved-commit deploy pwned=%q, want \"yes\" — the fixture's two commits do not actually differ, so the TOCTOU assertion would be vacuous", got)
	}
	t.Log("TOCTOU proven: pinned-commit deploy applied v1 (no pwned) even though the branch ref had advanced to a commit that injects pwned")
}

// ─────────────────────────── assertions / helpers ───────────────────────────

// assertByoKubeconfigReady writes the module's emitted kubeconfig output and asserts a
// Ready node — independent proof the BYO module provisioned a real, reachable cluster.
func assertByoKubeconfigReady(t *testing.T, outputs map[string]interface{}) {
	t.Helper()
	raw, ok := outputs["byo_kubeconfig"].(string)
	if !ok || raw == "" {
		t.Fatalf("no byo_kubeconfig string in BYO outputs (got %T) — the module did not emit a kubeconfig", outputs["byo_kubeconfig"])
	}
	kc := filepath.Join(t.TempDir(), "kubeconfig")
	if err := os.WriteFile(kc, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "kubectl", "get", "nodes", "--no-headers")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kc)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get nodes via the BYO kubeconfig failed: %v\n%s", err, out)
	}
	if !hasReadyNode(string(out)) {
		t.Fatalf("no Ready node via the BYO kubeconfig:\n%s", out)
	}
	t.Logf("BYO cluster nodes via emitted kubeconfig:\n%s", out)
}

// assertKindClusterListed asserts `kind get clusters` lists clusterName (skips the check
// only if the kind CLI is absent — the kubeconfig-Ready check is the primary proof).
func assertKindClusterListed(t *testing.T, ctx context.Context, clusterName string) {
	t.Helper()
	if _, err := exec.LookPath("kind"); err != nil {
		t.Logf("kind CLI absent — skipping `kind get clusters` cross-check (kubeconfig-Ready already proved the cluster)")
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kind", "get", "clusters").CombinedOutput()
	if err != nil {
		t.Fatalf("kind get clusters: %v\n%s", err, out)
	}
	if !clusterLineMatch(string(out), clusterName) {
		t.Fatalf("`kind get clusters` does not list %q:\n%s", clusterName, out)
	}
}

// assertKindClusterGone asserts `kind get clusters` no longer lists clusterName.
func assertKindClusterGone(t *testing.T, ctx context.Context, clusterName string) {
	t.Helper()
	if _, err := exec.LookPath("kind"); err != nil {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kind", "get", "clusters").CombinedOutput()
	if err != nil {
		// "No kind clusters found" exits non-zero on some versions — treat as gone.
		if strings.Contains(strings.ToLower(string(out)), "no kind clusters") {
			return
		}
		t.Fatalf("kind get clusters (post-destroy): %v\n%s", err, out)
	}
	if clusterLineMatch(string(out), clusterName) {
		t.Fatalf("cluster %q still listed after RunDestroy:\n%s", clusterName, out)
	}
}

func clusterLineMatch(out, name string) bool {
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == name {
			return true
		}
	}
	return false
}

// hasFinding reports whether the report has an error-severity finding of rule ruleSlug
// whose detail mentions substr.
func hasFinding(r *iacsafety.Report, ruleSlug, substr string) bool {
	for _, f := range r.Findings {
		if f.Severity == iacsafety.SeverityError && f.Rule == ruleSlug && strings.Contains(f.Detail, substr) {
			return true
		}
	}
	return false
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// outputString extracts a string tofu output value (tofu Output returns map[name]->{value,...}
// via the provisioner, which flattens to the raw value here).
func outputString(outputs map[string]interface{}, key string) string {
	v, ok := outputs[key]
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

func truncateState(b []byte) string {
	const max = 1500
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "…(truncated)"
}
