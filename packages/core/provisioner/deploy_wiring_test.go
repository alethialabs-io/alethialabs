// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// ── Shared E2E harness helpers (used by this file AND the e2e_local-tagged
// deploy_e2e_test.go — untagged files compile into every build, so these
// helpers are visible with or without the e2e_local tag). ──────────────────

// startTestStateServer stands up an in-memory OpenTofu `http` state backend that
// speaks exactly what cloud.HTTPBackendConfig points tofu at (GET/POST/DELETE the
// state, POST/DELETE the lock). It lets the T0 tests drive the REAL RunDeployV2
// spine — which mandates a StateBackend — without the console or any storage key.
func startTestStateServer(t *testing.T) *httptest.Server {
	t.Helper()
	var (
		mu        sync.Mutex
		state     []byte
		haveState bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/lock"):
			// LOCK (POST) / UNLOCK (DELETE): a single-writer test always acquires.
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet:
			if !haveState {
				w.WriteHeader(http.StatusNotFound) // no state yet => empty
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(state)
		case r.Method == http.MethodPost:
			b, _ := io.ReadAll(r.Body)
			state = b
			haveState = true
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodDelete:
			state, haveState = nil, false
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newLocalProjectConfig builds a minimal ProjectConfig for the local E2E: empty
// CloudIdentityID + empty per-resource placements => ValidatePlacement passes, and
// an empty AppsDestinationRepo => the ArgoCD/GitOps tail is non-fatal (not requested).
func newLocalProjectConfig(project, env string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ID:               "e2e-" + env,
		ProjectName:      project,
		EnvironmentStage: env,
		Region:           "local",
	}
}

// testStateBackend points the deploy at the in-test http state server.
func testStateBackend(srv *httptest.Server) *cloud.HTTPBackendConfig {
	return &cloud.HTTPBackendConfig{ConsoleURL: srv.URL, JobID: "e2e-local", Token: "test-token"}
}

// genEd25519 returns a fresh ed25519 keypair for receipt signing/verification.
func genEd25519(t *testing.T) (ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	return priv, pub
}

// shortID returns 8 lowercase hex chars — a collision-resistant, kind-name-safe
// suffix so parallel/repeat runs never clash on a cluster/container name.
func shortID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// repoRoot resolves the repository root as an absolute path, relative to THIS test
// file (not the process CWD) — packages/core/provisioner/<file> is three dirs deep.
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

// tLogWriter pipes provisioner stdout/stderr into the test log so a failure shows
// exactly where the spine stopped.
type tLogWriter struct{ t *testing.T }

func (w tLogWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", bytes.TrimRight(p, "\n"))
	return len(p), nil
}

// wiringModuleTF is a trivial, provider-less module (built-in `terraform_data`, so
// `tofu init` downloads nothing and needs NO docker). It emits no talos_* output,
// so ExtractClusterName returns "" and the post-apply cluster spine is correctly
// SKIPPED — which is exactly what this fast test asserts, alongside the fact that
// the plan -> verify-gate -> signed-receipt WIRING still fired.
const wiringModuleTF = `terraform {
  required_version = ">= 1.6"
  backend "http" {}
}

variable "project_name" {
  type    = string
  default = "wiring"
}

resource "terraform_data" "noop" {
  input = var.project_name
}

output "noop" {
  value = terraform_data.noop.output
}
`

// TestE2EProvisionWiringClusterless is the fast, docker-FREE half of the keystone:
// it drives the real RunDeployV2 through plan -> verify gate -> signed evidence
// receipt -> apply against a trivial provider-less module, and asserts the wiring
// fired even though there is no cluster (so it runs on every PR that has `tofu`).
// It complements the docker-gated kind test that lights up the full cluster spine.
func TestE2EProvisionWiringClusterless(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping (bare CI without OpenTofu)")
	}

	// Sign the receipt so we can prove it's sealed to the plan AND verifies.
	priv, pub := genEd25519(t)
	t.Setenv(verify.SigningKeyEnv, base64.StdEncoding.EncodeToString(priv))

	// Write the trivial module to an isolated workdir.
	modDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(modDir, "main.tf"), []byte(wiringModuleTF), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := startTestStateServer(t)
	env := "wire" + shortID(t)
	vc := newLocalProjectConfig("alethia", env)

	logw := tLogWriter{t}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	result, err := RunDeployV2(ctx, DeployParams{
		ProjectConfig: vc,
		Provider:      "hetzner", // reuse a real provider; the module emits no cluster
		TemplatesDir:  modDir,
		StateBackend:  testStateBackend(srv),
		DryRun:        false,
		Stdout:        logw,
		Stderr:        logw,
	})
	// Guaranteed teardown: destroy the (trivial) state so nothing lingers.
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer dcancel()
		if derr := RunDestroy(dctx, DestroyParams{
			ProjectConfig: vc,
			Provider:      "hetzner",
			TemplatesDir:  modDir,
			StateBackend:  testStateBackend(srv),
			Stdout:        logw,
			Stderr:        logw,
		}); derr != nil {
			t.Logf("wiring teardown (non-fatal): %v", derr)
		}
	})
	if err != nil {
		t.Fatalf("RunDeployV2 (wiring): %v", err)
	}

	// The spine is correctly GATED: no cluster output => no ClusterName, no
	// post-apply cluster work. (This is the honest counterpart to the kind test's
	// "ClusterName != ''" — together they prove the gate isn't vacuous either way.)
	if result.ClusterName != "" {
		t.Fatalf("expected no ClusterName for a cluster-less module, got %q", result.ClusterName)
	}
	if result.ClusterReady {
		t.Fatal("ClusterReady must be false when no cluster was provisioned")
	}

	// The plan -> verify -> receipt wiring MUST have fired on the plan JSON.
	if result.VerifyReport == nil {
		t.Fatal("VerifyReport is nil — the verification gate did not run on the plan JSON")
	}
	if result.VerifyReport.Verdict == "" {
		t.Fatal("verification report has no verdict — the gate produced nothing")
	}
	assertSealedSignedReceipt(t, result.VerifyReceipt, pub)
}

// assertSealedSignedReceipt is the shared receipt check: the receipt exists, is
// sealed to a real plan hash (64-hex sha256), carries the report's verdict, and its
// ed25519 signature verifies under pub. Shared by both T0 variants.
func assertSealedSignedReceipt(t *testing.T, sr *verify.SignedReceipt, pub ed25519.PublicKey) {
	t.Helper()
	if sr == nil {
		t.Fatal("VerifyReceipt is nil — no evidence receipt was built")
	}
	if len(sr.Receipt.PlanSHA256) != 64 {
		t.Fatalf("receipt PlanSHA256 = %q, want a 64-char hex sha256 sealing it to the plan", sr.Receipt.PlanSHA256)
	}
	if sr.Receipt.Report == nil {
		t.Fatal("receipt does not embed the verification report")
	}
	if sr.Algorithm != "ed25519" {
		t.Fatalf("receipt algorithm = %q, want ed25519 (signing key was configured)", sr.Algorithm)
	}
	if err := sr.Verify(pub); err != nil {
		t.Fatalf("receipt signature does not verify: %v", err)
	}
}
