// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// ── Shared fixtures for the deploy-spine + placement-lane coverage suite ──────────
//
// Everything here is offline and deterministic. Two levers do the work:
//
//   - a FAKE `kubectl`/`helm` on PATH. The deploy spine and the argocd package shell out
//     through `bash -c` (utils.ExecuteCommand reads os.Environ()), so a stub that answers the
//     handful of reads the spine parses lets the post-apply half run end-to-end with no
//     cluster. Only the provisioner's own `executeCommand` is a package var; argocd's calls
//     are not, which is why the stub lives on PATH rather than in a seam.
//   - provider "hetzner", whose ConfigureKubeconfig is pure file I/O over the `kubeconfig`
//     output (no cloud API), and whose TalosKubeconfigMinter is injected by the caller.

// depRepoRoot resolves the repository root from THIS file's location (not the process CWD) —
// packages/core/provisioner/<file> is three directories deep.
func depRepoRoot(t *testing.T) string {
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

// depVClusterKubeconfig is the kubeconfig the vcluster chart exports into its Secret. The vcluster
// registration parses it for server + CA + token, and fails closed if any is missing.
const depVClusterKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: vc
  cluster:
    server: https://vcluster.cov.svc:443
    certificate-authority-data: Q0FEQVRB
users:
- name: vc
  user:
    token: cov-sa-token
`

// depFakeKubectlScript builds the stub `kubectl`. It exits 0 for everything and answers the three
// reads the spine actually PARSES — readyz, the node list, and the vcluster-exported kubeconfig
// Secret — so every bounded wait converges on the first attempt instead of burning its retries.
func depFakeKubectlScript() string {
	cfg := base64.StdEncoding.EncodeToString([]byte(depVClusterKubeconfig))
	secret := `{"data":{"config":"` + cfg + `"}}`
	return `#!/bin/sh
if [ -n "$COV_KUBECTL_FAIL" ]; then
  case "$*" in
    $COV_KUBECTL_FAIL) echo "cov: forced kubectl failure" >&2; exit 1 ;;
  esac
fi
case "$*" in
  *"get nodes -o json"*)
    echo '{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}'
    ;;
  *"get secret vcluster-kubeconfig-"*"-o json"*)
    echo '` + secret + `'
    ;;
esac
exit 0
`
}

// depFakeTool is the stub for every other shelled tool (helm, git): exit 0 unless the test asked
// for a forced failure via COV_TOOL_FAIL (an sh glob matched against the arguments).
const depFakeTool = `#!/bin/sh
if [ -n "$COV_TOOL_FAIL" ]; then
  case "$*" in
    $COV_TOOL_FAIL) echo "cov: forced tool failure" >&2; exit 1 ;;
  esac
fi
exit 0
`

// depFakeBins writes stub executables into a temp dir and PREPENDS it to PATH for the test.
// The real PATH is kept so `bash` and `tofu` still resolve.
func depFakeBins(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		body := depFakeTool
		if n == "kubectl" {
			body = depFakeKubectlScript()
		}
		if err := os.WriteFile(filepath.Join(dir, n), []byte(body), 0o755); err != nil {
			t.Fatalf("write fake %s: %v", n, err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

// depTalosMinter is the injected TalosKubeconfigMinter for the hetzner placement lanes: it returns a
// syntactically valid kubeconfig, which is all hetznerProvider.ConfigureKubeconfig needs (it writes
// the file and exports KUBECONFIG — no cloud API at all). That is what makes the namespace and
// vcluster lanes drivable offline.
func depTalosMinter(kubeconfig string) TalosKubeconfigMinter {
	return func(context.Context, *types.ProjectConfig, string) (string, error) {
		return kubeconfig, nil
	}
}

// depPlacementConfig builds a placement-mode ProjectConfig resolved onto a shared Fabric cluster.
func depPlacementConfig(mode types.PlacementMode, ns string) *types.ProjectConfig {
	vc := newLocalProjectConfig("alethia", "plc")
	vc.PlacementMode = mode
	vc.Cluster.ClusterName = "fabric-1"
	vc.Namespace = ns
	return vc
}

// depIsolateHome gives the test a private HOME (the hetzner provider writes
// $HOME/.alethia/kubeconfig and exports KUBECONFIG) and neutralises KUBECONFIG so the
// os.Setenv inside the provider is restored when the test ends.
func depIsolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KUBECONFIG", "")
	return home
}

// depRequireTofu skips when OpenTofu is not on PATH (bare CI without it), mirroring the
// package's existing wiring keystone.
func depRequireTofu(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping the real-apply spine coverage")
	}
}

// depClusterModuleTF is a provider-less module (built-in `terraform_data`, so `tofu init`
// downloads nothing) that EMITS the outputs the post-apply spine keys on: a talos cluster name
// (ExtractClusterName), a kubeconfig (hetznerProvider.ConfigureKubeconfig) and a bootstrap
// manifest (applyBootstrapManifests). That is what turns the clusterless wiring test into a
// full-spine test without a cluster.
const depClusterModuleTF = `terraform {
  required_version = ">= 1.6"
  backend "http" {}
}

variable "project_name" {
  type    = string
  default = "cov"
}

resource "terraform_data" "noop" {
  input = var.project_name
}

output "talos_cluster_name" {
  value = "cov-${terraform_data.noop.output}"
}

output "kubeconfig" {
  value = "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n"
}

output "bootstrap_manifests" {
  value = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: cov-bootstrap\n"
}
`

// depWriteModule writes a single-file tofu module into a fresh temp dir and returns it.
func depWriteModule(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(body), 0o644); err != nil {
		t.Fatalf("write module: %v", err)
	}
	return dir
}

// depArgoTemplates points the ArgoCD template resolver at the repo's baked templates (the
// runner-image paths do not exist under `go test`).
func depArgoTemplates(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(depRepoRoot(t), "infra", "templates", "argocd")
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("argocd templates not found at %s: %v", dir, err)
	}
	t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", dir)
	return dir
}

// depNoSlowProbes bounds every wait the spine performs so a stubbed cluster converges at once.
func depNoSlowProbes(t *testing.T) {
	t.Helper()
	t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "30s")
	t.Setenv("ALETHIA_ADDON_CONVERGE_TIMEOUT", "0")
	t.Setenv("ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE", "1")
	// Keep the deploy from reaching for a real registry/DNS/cloud in the optional lanes.
	t.Setenv("ALETHIA_VERIFY_ACCESS_ANALYZER", "")
	t.Setenv("ALETHIA_XACCT_HELM_ECR_ENABLED", "")
}

// depContains fails the test unless haystack contains needle.
func depContains(t *testing.T, haystack, needle, what string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("%s: %q does not contain %q", what, haystack, needle)
	}
}

// TestDep_SpinePostApplyClusterPath pins the WHOLE RunDeployV2 spine past the apply: a module
// that emits talos_cluster_name + kubeconfig + bootstrap_manifests drives ExtractClusterName →
// ConfigureKubeconfig → applyBootstrapManifests → the reachability + pod-datapath gates →
// installArgoCD → the infra-service render/apply → the add-on prunes → the GitOps snapshot.
// Without a cluster the spine used to stop at "no talos output"; this proves the post-apply
// half actually executes and reports ClusterReady + InfraServices + GitopsStatus.
func TestDep_SpinePostApplyClusterPath(t *testing.T) {
	depRequireTofu(t)
	depIsolateHome(t)
	depFakeBins(t, "kubectl", "helm", "git")
	depArgoTemplates(t)
	depNoSlowProbes(t)

	srv := startTestStateServer(t)
	env := "cov" + shortID(t)
	vc := newLocalProjectConfig("alethia", env)
	modDir := depWriteModule(t, depClusterModuleTF)
	logw := tLogWriter{t}

	params := DeployParams{
		ProjectConfig: vc,
		Provider:      "hetzner",
		TemplatesDir:  modDir,
		StateBackend:  testStateBackend(srv),
		Stdout:        logw,
		Stderr:        logw,
		// A waiver of a control that is NOT failing here. It changes no verdict — its only job is
		// to prove the audit line the gate emits alongside a conclusive report, which is the half
		// of the override path the missing-verdict backstop test can never reach (that one has no
		// report at all).
		VerifyOverride: &verify.Override{
			By:       "cov-operator",
			Reason:   "coverage probe",
			Expiry:   time.Now().Add(time.Hour),
			Controls: []string{"LEASTPRIV-001"},
		},
	}
	t.Cleanup(func() {
		// A fresh context: t.Context() is already cancelled by the time cleanups run.
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
			t.Logf("teardown (non-fatal): %v", derr)
		}
	})

	result, err := RunDeployV2(t.Context(), params)
	if err != nil {
		t.Fatalf("RunDeployV2 (post-apply spine): %v", err)
	}
	if result.ClusterName == "" {
		t.Fatal("ClusterName is empty — ExtractClusterName did not see talos_cluster_name, so the post-apply spine was SKIPPED")
	}
	if !result.ClusterReady {
		t.Fatal("ClusterReady is false — the reachability + pod-datapath gates did not run")
	}
	if len(result.InfraServices) == 0 {
		t.Error("InfraServices is empty — the infra-service decision set was never recorded, so the ArgoCD tail did not run")
	}
	if result.GitopsStatus == nil {
		t.Fatal("GitopsStatus is nil after a real apply — the GitOps snapshot did not run")
	}
	if result.GitopsStatus.Mode != "direct" {
		t.Errorf("GitopsStatus.Mode = %q, want direct (no apps repo configured)", result.GitopsStatus.Mode)
	}
	if result.SecurityPosture == nil {
		t.Error("SecurityPosture is nil — the Trivy posture read is unconditional after a real apply")
	}
}

// TestDep_NamespaceLaneHetznerEndToEnd drives the FULL namespace placement lane through the
// RunDeployV2 dispatch: keyless Talos mint → reachability probe → tenant render → isolation apply
// → guardrail bundle → the hetzner identity no-op → the app Application. The apps-repo half is
// exercised twice: with a token (ConfigureRepoCredentials + an app Application) and without one
// (guarded namespace, no Application) — the two ends of the fail-closed switch.
func TestDep_NamespaceLaneHetznerEndToEnd(t *testing.T) {
	for _, tc := range []struct {
		name     string
		appsRepo string
		token    string
		wantApp  bool
	}{
		{"apps repo with token → app Application applied", "https://github.com/acme/apps.git", "ghp_cov", true},
		{"no apps repo → namespace guarded, no Application", "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			depIsolateHome(t)
			depFakeBins(t, "kubectl", "helm")
			depArgoTemplates(t)
			depNoSlowProbes(t)

			vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
			vc.Repositories.AppsDestinationRepo = tc.appsRepo
			vc.Repositories.AppsPath = "overlays/dev"

			var out strings.Builder
			result, err := RunDeployV2(t.Context(), DeployParams{
				ProjectConfig:   vc,
				Provider:        "hetzner",
				GitAccessToken:  tc.token,
				TalosKubeconfig: depTalosMinter("apiVersion: v1\nkind: Config\n"),
				Stdout:          &out,
				Stderr:          &out,
			})
			if err != nil {
				t.Fatalf("namespace lane: %v\n%s", err, out.String())
			}
			if result.ClusterName != "fabric-1" {
				t.Errorf("ClusterName = %q, want the shared Fabric cluster fabric-1", result.ClusterName)
			}
			if !result.ClusterReady {
				t.Error("ClusterReady is false — the post-mint reachability probe did not run")
			}
			if result.GitopsStatus == nil {
				t.Fatal("GitopsStatus is nil — the namespace lane must record its wiring mode")
			}
			// The hetzner identity lane is a DOCUMENTED no-op (no cloud IAM), not a silent one.
			depContains(t, out.String(), "k8s-native isolation only", "hetzner namespace identity")
			depContains(t, out.String(), "namespace guardrail bundle", "guardrail bundle apply")
			if tc.wantApp {
				depContains(t, out.String(), "namespace app Application", "app Application apply")
				if result.GitopsStatus.Mode != "gitops" {
					t.Errorf("GitopsStatus.Mode = %q, want gitops", result.GitopsStatus.Mode)
				}
			} else {
				depContains(t, out.String(), "no app Application deployed", "guarded-only namespace")
				if result.GitopsStatus.Mode != "direct" {
					t.Errorf("GitopsStatus.Mode = %q, want direct", result.GitopsStatus.Mode)
				}
			}
		})
	}
}

// TestDep_VClusterLaneHetznerEndToEnd drives the FULL vcluster placement lane through the
// RunDeployV2 dispatch: spec derivation → keyless host mint → reachability → helm create +
// WaitReady → the ArgoCD cluster-Secret registration (which parses the exported kubeconfig) →
// AppProject + app Application delivery.
func TestDep_VClusterLaneHetznerEndToEnd(t *testing.T) {
	depIsolateHome(t)
	depFakeBins(t, "kubectl", "helm")
	depArgoTemplates(t)
	depNoSlowProbes(t)

	vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
	vc.Repositories.AppsDestinationRepo = "https://github.com/acme/apps.git"
	vc.Repositories.AppsPath = "overlays/prod"

	var out strings.Builder
	result, err := RunDeployV2(t.Context(), DeployParams{
		ProjectConfig:   vc,
		Provider:        "hetzner",
		GitAccessToken:  "ghp_cov",
		TalosKubeconfig: depTalosMinter("apiVersion: v1\nkind: Config\n"),
		Stdout:          &out,
		Stderr:          &out,
	})
	if err != nil {
		t.Fatalf("vcluster lane: %v\n%s", err, out.String())
	}
	if result.ClusterName != "tenant-a" {
		t.Errorf("ClusterName = %q, want the vcluster name tenant-a", result.ClusterName)
	}
	if !result.ClusterReady {
		t.Error("ClusterReady is false — the post-mint host reachability probe did not run")
	}
	depContains(t, out.String(), "Creating vcluster", "vcluster helm create")
	depContains(t, out.String(), "Registering vcluster", "ArgoCD cluster-Secret registration")
	depContains(t, out.String(), "vcluster app Application", "app Application apply")
	if result.GitopsStatus == nil || result.GitopsStatus.Mode != "gitops" {
		t.Errorf("GitopsStatus = %+v, want gitops mode", result.GitopsStatus)
	}
}

// depFailExec swaps the package's `executeCommand` seam so the nth shell-out whose command
// contains `substr` fails; everything else is delegated to the real implementation. It is how a
// test distinguishes two apply steps that shell the SAME command shape (namespace isolation vs
// the app Application both run `kubectl apply -f <alethia-ns-*>`).
func depFailExec(t *testing.T, substr string, nth int) {
	t.Helper()
	orig := executeCommand
	n := 0
	executeCommand = func(cmd, dir string, env []string, out, errw io.Writer) error {
		if strings.Contains(cmd, substr) {
			n++
			if n == nth {
				return fmt.Errorf("cov: forced failure of %q (occurrence %d)", substr, n)
			}
		}
		return orig(cmd, dir, env, out, errw)
	}
	t.Cleanup(func() { executeCommand = orig })
}

// depGCPPlacementParams builds the DeployParams for a gcp placement lane. gcp is drivable offline
// because gcpProvider.ConfigureKubeconfig only writes an exec-plugin kubeconfig from the
// endpoint/CA the injected KubeConnResolver supplies — no cloud API call.
func depGCPPlacementParams(vc *types.ProjectConfig, identity NamespaceIdentityProvisioner, out io.Writer) DeployParams {
	return DeployParams{
		ProjectConfig: vc,
		Provider:      "gcp",
		KubeConn: func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			return "https://10.0.0.1", "Q0FEQVRB", nil
		},
		NamespaceIdentity: identity,
		Stdout:            out,
		Stderr:            out,
	}
}

// TestDep_NamespaceLaneFailClosedGuards pins every guard runNamespaceDeploy applies BEFORE it
// touches the shared Fabric: an unwired cloud, a snapshot missing the cluster or the namespace,
// and a namespace/cluster name that is not shell- and YAML-safe. Each must refuse, never guess.
func TestDep_NamespaceLaneFailClosedGuards(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		mutate   func(*types.ProjectConfig)
		want     string
	}{
		{"unwired cloud", "digitalocean", func(*types.ProjectConfig) {}, "not yet activated"},
		{"no serving cluster", "hetzner", func(vc *types.ProjectConfig) { vc.Cluster.ClusterName = " " }, "no serving cluster"},
		{"no destination namespace", "hetzner", func(vc *types.ProjectConfig) { vc.Namespace = "" }, "no destination namespace"},
		{"namespace is not a DNS-1123 label", "hetzner", func(vc *types.ProjectConfig) { vc.Namespace = "Team Web" }, "not a valid DNS-1123 label"},
		{"cluster name is not shell-safe", "hetzner", func(vc *types.ProjectConfig) { vc.Cluster.ClusterName = "fab;rm -rf /" }, "invalid characters"},
		{"apps path traversal", "hetzner", func(vc *types.ProjectConfig) { vc.Repositories.AppsPath = "../../etc" }, "namespace placement:"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
			tc.mutate(vc)
			var out strings.Builder
			_, err := runNamespaceDeploy(t.Context(), DeployParams{
				ProjectConfig: vc, Provider: tc.provider, Stdout: &out, Stderr: &out,
			})
			if err == nil {
				t.Fatalf("%s: got nil error, want a fail-closed refusal", tc.name)
			}
			depContains(t, err.Error(), tc.want, tc.name)
		})
	}
}

// TestDep_NamespaceLaneNilWritersDefaultToProcessStreams pins the writer defaulting: a caller that
// supplies neither Stdout nor Stderr still runs (the lane falls back to the process streams) and
// still fails closed on the guard it should. Also exercises the deferred stage span's error stamp.
func TestDep_NamespaceLaneNilWritersDefaultToProcessStreams(t *testing.T) {
	vc := depPlacementConfig(types.PlacementModeNamespace, "")
	if _, err := runNamespaceDeploy(t.Context(), DeployParams{ProjectConfig: vc, Provider: "hetzner"}); err == nil {
		t.Fatal("expected the missing-namespace refusal even with nil writers")
	}
}

// TestDep_NamespaceLaneMintAndProbeFailures pins the three fail-closed stops between preflight and
// the first cluster write: missing kubectl, a mint that cannot produce kube access, and a Fabric
// that never answers. None may proceed to touch the shared cluster.
func TestDep_NamespaceLaneMintAndProbeFailures(t *testing.T) {
	t.Run("preflight: kubectl missing", func(t *testing.T) {
		depIsolateHome(t)
		t.Setenv("PATH", t.TempDir()) // no kubectl anywhere
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		_, err := runNamespaceDeploy(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("expected the preflight refusal when kubectl is absent")
		}
		depContains(t, err.Error(), "preflight check failed", "preflight")
	})

	t.Run("mint: no injected Talos minter", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		_, err := runNamespaceDeploy(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("expected the mint refusal when hetzner has no injected Talos minter")
		}
		depContains(t, err.Error(), "kubeconfig mint failed", "mint")
	})

	t.Run("probe: Fabric unreachable after minting", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		t.Setenv("COV_KUBECTL_FAIL", "get --raw*")
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "1ms")
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		_, err := runNamespaceDeploy(t.Context(), DeployParams{
			ProjectConfig:   vc,
			Provider:        "hetzner",
			TalosKubeconfig: depTalosMinter("apiVersion: v1\nkind: Config\n"),
			Stdout:          &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("expected the reachability refusal when the Fabric never answers")
		}
		depContains(t, err.Error(), "unreachable after minting kube access", "reachability")
	})
}

// TestDep_NamespaceLaneWiringFailuresRecordTheStep pins the GitOps/apply failure contract: every
// hard stop after the mint returns a PARTIAL result carrying the failed step, so the console can
// show WHY the namespace is not wired instead of a bare failed job.
func TestDep_NamespaceLaneWiringFailuresRecordTheStep(t *testing.T) {
	const repo = "https://github.com/acme/apps.git"

	newParams := func(vc *types.ProjectConfig, token string, out io.Writer) DeployParams {
		return DeployParams{
			ProjectConfig:   vc,
			Provider:        "hetzner",
			GitAccessToken:  token,
			TalosKubeconfig: depTalosMinter("apiVersion: v1\nkind: Config\n"),
			Stdout:          out, Stderr: out,
		}
	}

	t.Run("repo credentials apply fails", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		t.Setenv("COV_KUBECTL_FAIL", "*argocd-repo-*")
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		vc.Repositories.AppsDestinationRepo = repo
		var out strings.Builder
		result, err := runNamespaceDeploy(t.Context(), newParams(vc, "ghp_cov", &out))
		if err == nil {
			t.Fatal("expected the repo-credential failure to fail the deploy")
		}
		if result == nil || result.GitopsStatus == nil || result.GitopsStatus.FailedStep == "" {
			t.Fatalf("want a partial result naming the failed step, got %+v", result)
		}
	})

	t.Run("no token and the repo is not anonymously cloneable", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		// A closed port: the anonymous ref-advertisement probe fails immediately, with no DNS and
		// no outbound traffic — the probe is fail-closed, so this lands in the default branch.
		vc.Repositories.AppsDestinationRepo = "https://127.0.0.1:1/acme/apps.git"
		var out strings.Builder
		result, err := runNamespaceDeploy(t.Context(), newParams(vc, "", &out))
		if err == nil {
			t.Fatal("expected GitOps to be refused without a token on a non-public repo")
		}
		depContains(t, err.Error(), "not anonymously cloneable", "git token gate")
		if result == nil || result.GitopsStatus == nil {
			t.Fatal("want a partial result carrying the git-token failure")
		}
	})

	t.Run("tenant render fails closed", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		vc.ProjectName = "" // RenderNamespaceTenant requires a project
		var out strings.Builder
		result, err := runNamespaceDeploy(t.Context(), newParams(vc, "", &out))
		if err == nil {
			t.Fatal("expected the tenant render to fail closed on a missing project")
		}
		depContains(t, err.Error(), "render namespace tenant isolation", "render step")
		if result == nil || result.GitopsStatus == nil {
			t.Fatal("want a partial result carrying the render failure")
		}
	})

	t.Run("isolation apply fails", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		depFailExec(t, "alethia-ns-", 1)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		_, err := runNamespaceDeploy(t.Context(), newParams(vc, "", &out))
		if err == nil {
			t.Fatal("expected the namespace-isolation apply failure to fail the deploy")
		}
		depContains(t, err.Error(), "failed to apply namespace isolation", "isolation apply")
	})

	t.Run("guardrail bundle missing", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		// Templates dir that exists but carries no preview-guardrails bundle.
		t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", t.TempDir())
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		_, err := runNamespaceDeploy(t.Context(), newParams(vc, "", &out))
		if err == nil {
			t.Fatal("expected the missing guardrail bundle to fail the deploy")
		}
		depContains(t, err.Error(), "guardrail bundle", "guardrail bundle")
	})

	t.Run("app Application apply fails", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		depFailExec(t, "alethia-ns-", 2) // 1 = isolation, 2 = the app Application
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		vc.Repositories.AppsDestinationRepo = repo
		var out strings.Builder
		_, err := runNamespaceDeploy(t.Context(), newParams(vc, "ghp_cov", &out))
		if err == nil {
			t.Fatal("expected the app-Application apply failure to fail the deploy")
		}
		depContains(t, err.Error(), "namespace app Application", "app apply")
	})
}

// TestDep_NamespaceLaneGCPIdentity drives the gcp namespace lane end-to-end: the injected
// KubeConnResolver supplies endpoint+CA, the injected NamespaceIdentityProvisioner returns a GSA
// email, and the default ServiceAccount is annotated for Workload Identity. It also pins the two
// fail-closed halves of that seam — a missing provisioner and a malformed GSA.
func TestDep_NamespaceLaneGCPIdentity(t *testing.T) {
	const gsa = "cov-ns@my-project.iam.gserviceaccount.com"

	t.Run("binds the default SA to the per-namespace GSA", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		identity := func(context.Context, string, *types.ProjectConfig, string, string) (string, error) {
			return gsa, nil
		}
		result, err := runNamespaceDeploy(t.Context(), depGCPPlacementParams(vc, identity, &out))
		if err != nil {
			t.Fatalf("gcp namespace lane: %v\n%s", err, out.String())
		}
		if !result.ClusterReady {
			t.Error("ClusterReady is false — the gcp lane's reachability probe did not run")
		}
		depContains(t, out.String(), "per-namespace GCP identity", "GKE Workload Identity binding")
	})

	t.Run("no injected provisioner is a wiring bug, not a silent skip", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		_, err := runNamespaceDeploy(t.Context(), depGCPPlacementParams(vc, nil, &out))
		if err == nil {
			t.Fatal("expected a wiring-bug refusal when gcp has no injected identity provisioner")
		}
		depContains(t, err.Error(), "runner wiring bug", "nil identity provisioner")
	})

	t.Run("a malformed GSA is refused", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		identity := func(context.Context, string, *types.ProjectConfig, string, string) (string, error) {
			return "not an email", nil
		}
		_, err := runNamespaceDeploy(t.Context(), depGCPPlacementParams(vc, identity, &out))
		if err == nil {
			t.Fatal("expected a malformed GSA email to be refused")
		}
		depContains(t, err.Error(), "malformed", "malformed GSA")
	})

	t.Run("the identity provisioner's error propagates", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		identity := func(context.Context, string, *types.ProjectConfig, string, string) (string, error) {
			return "", errors.New("IAM write denied")
		}
		_, err := runNamespaceDeploy(t.Context(), depGCPPlacementParams(vc, identity, &out))
		if err == nil {
			t.Fatal("expected the identity provisioner's error to fail the deploy")
		}
		depContains(t, err.Error(), "IAM write denied", "identity error")
	})

	t.Run("the SA annotate failure is surfaced", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		depFailExec(t, "iam.gke.io/gcp-service-account", 1)
		vc := depPlacementConfig(types.PlacementModeNamespace, "team-web")
		var out strings.Builder
		identity := func(context.Context, string, *types.ProjectConfig, string, string) (string, error) {
			return gsa, nil
		}
		_, err := runNamespaceDeploy(t.Context(), depGCPPlacementParams(vc, identity, &out))
		if err == nil {
			t.Fatal("expected the ServiceAccount annotate failure to fail the deploy")
		}
		depContains(t, err.Error(), "failed to bind namespace", "SA annotate")
	})
}

// TestDep_KubectlApplyManifestTempFailures pins the two IO refusals in the shared manifest writer:
// an unusable temp root must surface as an error, never as a silently skipped apply.
func TestDep_KubectlApplyManifestTempFailures(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "does-not-exist"))
	if err := kubectlApplyManifest("kind: Namespace\n", "cov", io.Discard, io.Discard); err == nil {
		t.Error("kubectlApplyManifest with an unusable TMPDIR = nil, want an error")
	}
}

// TestDep_VClusterLaneFailClosedGuards pins the guards runVClusterDeploy applies before it
// helm-installs anything onto the shared Fabric, including the derived-name budget: a namespace
// that is itself a valid label can still push `vcluster-<ns>` past the 63-char DNS-1123 ceiling,
// and that must be refused rather than rendered.
func TestDep_VClusterLaneFailClosedGuards(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		mutate   func(*types.ProjectConfig)
		want     string
	}{
		{"unwired cloud", "digitalocean", func(*types.ProjectConfig) {}, "not yet activated"},
		{"no serving cluster", "hetzner", func(vc *types.ProjectConfig) { vc.Cluster.ClusterName = "" }, "no serving cluster"},
		{"no destination namespace", "hetzner", func(vc *types.ProjectConfig) { vc.Namespace = " " }, "no destination namespace"},
		{"namespace is not a DNS-1123 label", "hetzner", func(vc *types.ProjectConfig) { vc.Namespace = "Tenant_A" }, "not a valid DNS-1123 label"},
		{"cluster name is not shell-safe", "hetzner", func(vc *types.ProjectConfig) { vc.Cluster.ClusterName = "fab ric" }, "invalid characters"},
		{"apps path traversal", "hetzner", func(vc *types.ProjectConfig) { vc.Repositories.AppsPath = "../etc" }, "vcluster placement:"},
		{
			"derived host namespace busts the 63-char label ceiling",
			"hetzner",
			func(vc *types.ProjectConfig) { vc.Namespace = strings.Repeat("a", 60) },
			"is not a valid DNS-1123 label",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
			tc.mutate(vc)
			var out strings.Builder
			_, err := runVClusterDeploy(t.Context(), DeployParams{
				ProjectConfig: vc, Provider: tc.provider, Stdout: &out, Stderr: &out,
			})
			if err == nil {
				t.Fatalf("%s: got nil error, want a fail-closed refusal", tc.name)
			}
			depContains(t, err.Error(), tc.want, tc.name)
		})
	}
}

// TestDep_VClusterLaneNilWritersDefaultToProcessStreams pins the writer defaulting on the vcluster
// lane: no Stdout/Stderr still runs and still refuses the guard it should.
func TestDep_VClusterLaneNilWritersDefaultToProcessStreams(t *testing.T) {
	vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
	vc.Cluster.ClusterName = ""
	if _, err := runVClusterDeploy(t.Context(), DeployParams{ProjectConfig: vc, Provider: "hetzner"}); err == nil {
		t.Fatal("expected the missing-cluster refusal even with nil writers")
	}
}

// TestDep_VClusterLaneStepFailures pins every hard stop of the vcluster lane after the guards:
// preflight tooling, the host mint, the reachability probe, the helm create + rollout, the ArgoCD
// registration, and both delivery applies. Each must fail the deploy — a half-provisioned virtual
// cluster reported as success is exactly what this lane refuses to do.
func TestDep_VClusterLaneStepFailures(t *testing.T) {
	newParams := func(vc *types.ProjectConfig, out io.Writer) DeployParams {
		return DeployParams{
			ProjectConfig:   vc,
			Provider:        "hetzner",
			GitAccessToken:  "ghp_cov",
			TalosKubeconfig: depTalosMinter("apiVersion: v1\nkind: Config\n"),
			Stdout:          out, Stderr: out,
		}
	}
	base := func(t *testing.T) *types.ProjectConfig {
		t.Helper()
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		vc.Repositories.AppsDestinationRepo = "https://github.com/acme/apps.git"
		return vc
	}

	t.Run("preflight: helm missing", func(t *testing.T) {
		depIsolateHome(t)
		t.Setenv("PATH", t.TempDir())
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the vcluster preflight refusal when helm/kubectl are absent")
		}
		depContains(t, err.Error(), "vcluster preflight failed", "preflight")
	})

	t.Run("host mint fails", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("expected the host-mint refusal with no injected Talos minter")
		}
		depContains(t, err.Error(), "kubeconfig mint failed for existing host cluster", "host mint")
	})

	t.Run("host cluster unreachable", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		t.Setenv("COV_KUBECTL_FAIL", "get --raw*")
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "1ms")
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the host reachability refusal")
		}
		depContains(t, err.Error(), "unreachable after minting kube access", "host reachability")
	})

	t.Run("helm create fails", func(t *testing.T) {
		vc := base(t)
		depFailExec(t, "upgrade --install", 1)
		var out strings.Builder
		result, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the vcluster helm install failure to fail the deploy")
		}
		depContains(t, err.Error(), "failed to create vcluster", "helm create")
		if result == nil || !result.ClusterReady {
			t.Error("want the partial result to still record that the HOST was reachable")
		}
	})

	t.Run("control plane never rolls out", func(t *testing.T) {
		vc := base(t)
		depFailExec(t, "rollout status", 1)
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the rollout failure to fail the deploy")
		}
		depContains(t, err.Error(), "control plane not ready", "rollout")
	})

	t.Run("ArgoCD cluster registration fails", func(t *testing.T) {
		vc := base(t)
		t.Setenv("COV_KUBECTL_FAIL", "*argocd-manifest-*")
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the ArgoCD registration failure to fail the deploy")
		}
		depContains(t, err.Error(), "failed to register vcluster", "cluster registration")
	})

	t.Run("repo credentials apply fails", func(t *testing.T) {
		vc := base(t)
		t.Setenv("COV_KUBECTL_FAIL", "*argocd-repo-*")
		var out strings.Builder
		result, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the repo-credential failure to fail the deploy")
		}
		if result == nil || result.GitopsStatus == nil || result.GitopsStatus.FailedStep == "" {
			t.Fatalf("want a partial result naming the failed step, got %+v", result)
		}
	})

	t.Run("no token and the repo is not anonymously cloneable", func(t *testing.T) {
		vc := base(t)
		vc.Repositories.AppsDestinationRepo = "https://127.0.0.1:1/acme/apps.git"
		var out strings.Builder
		params := newParams(vc, &out)
		params.GitAccessToken = ""
		_, err := runVClusterDeploy(t.Context(), params)
		if err == nil {
			t.Fatal("expected GitOps to be refused without a token on a non-public repo")
		}
		depContains(t, err.Error(), "not anonymously cloneable", "git token gate")
	})

	t.Run("delivery render fails closed", func(t *testing.T) {
		vc := base(t)
		vc.ProjectName = "" // RenderVClusterApp requires a project
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the delivery render to fail closed on a missing project")
		}
		depContains(t, err.Error(), "render vcluster app delivery", "render")
	})

	t.Run("AppProject apply fails", func(t *testing.T) {
		vc := base(t)
		depFailExec(t, "alethia-ns-", 1)
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the AppProject apply failure to fail the deploy")
		}
		depContains(t, err.Error(), "failed to apply vcluster AppProject", "AppProject apply")
	})

	t.Run("app Application apply fails", func(t *testing.T) {
		vc := base(t)
		depFailExec(t, "alethia-ns-", 2) // 1 = AppProject, 2 = the app Application
		var out strings.Builder
		_, err := runVClusterDeploy(t.Context(), newParams(vc, &out))
		if err == nil {
			t.Fatal("expected the app-Application apply failure to fail the deploy")
		}
		depContains(t, err.Error(), "failed to apply vcluster app Application", "app apply")
	})

	t.Run("no apps repo leaves the vcluster registered but undelivered", func(t *testing.T) {
		vc := base(t)
		vc.Repositories.AppsDestinationRepo = ""
		var out strings.Builder
		params := newParams(vc, &out)
		params.GitAccessToken = ""
		result, err := runVClusterDeploy(t.Context(), params)
		if err != nil {
			t.Fatalf("vcluster lane without an apps repo: %v\n%s", err, out.String())
		}
		depContains(t, out.String(), "no app Application deployed", "undelivered vcluster")
		if result.GitopsStatus == nil || result.GitopsStatus.Mode != "direct" {
			t.Errorf("GitopsStatus = %+v, want direct mode", result.GitopsStatus)
		}
	})
}

// TestDep_VClusterDestroy pins the teardown lane: an unwired cloud is a documented no-op, a
// snapshot with no usable cluster warns instead of guessing, and the happy path mints host access
// and deregisters both the vcluster and its ArgoCD cluster Secret.
func TestDep_VClusterDestroy(t *testing.T) {
	provider, err := cloud.NewCloudProvider("hetzner")
	if err != nil {
		t.Fatalf("hetzner provider: %v", err)
	}

	t.Run("unwired cloud is a documented skip", func(t *testing.T) {
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		var out strings.Builder
		if err := runVClusterDestroy(t.Context(), provider, DestroyParams{
			ProjectConfig: vc, Provider: "digitalocean", Stdout: &out, Stderr: &out,
		}); err != nil {
			t.Fatalf("unwired teardown = %v, want a documented no-op", err)
		}
		depContains(t, out.String(), "nothing was provisioned", "unwired teardown")
	})

	t.Run("nil writers default to the process streams", func(t *testing.T) {
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		if err := runVClusterDestroy(t.Context(), provider, DestroyParams{
			ProjectConfig: vc, Provider: "digitalocean",
		}); err != nil {
			t.Fatalf("unwired teardown with nil writers = %v, want nil", err)
		}
	})

	t.Run("a bad spec fails closed", func(t *testing.T) {
		vc := depPlacementConfig(types.PlacementModeVcluster, "")
		var out strings.Builder
		if err := runVClusterDestroy(t.Context(), provider, DestroyParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		}); err == nil {
			t.Fatal("expected a spec refusal when the snapshot has no namespace")
		}
	})

	t.Run("no usable serving cluster warns rather than guessing", func(t *testing.T) {
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		vc.Cluster.ClusterName = "bad cluster name"
		var out strings.Builder
		if err := runVClusterDestroy(t.Context(), provider, DestroyParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		}); err != nil {
			t.Fatalf("teardown with an unusable cluster name = %v, want a warning and nil", err)
		}
		depContains(t, out.String(), "cannot mint host access", "unusable cluster name")
	})

	t.Run("preflight tooling is required", func(t *testing.T) {
		depIsolateHome(t)
		t.Setenv("PATH", t.TempDir())
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		var out strings.Builder
		if err := runVClusterDestroy(t.Context(), provider, DestroyParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		}); err == nil {
			t.Fatal("expected the teardown preflight refusal when helm/kubectl are absent")
		}
	})

	t.Run("mint failure fails the teardown", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		var out strings.Builder
		if err := runVClusterDestroy(t.Context(), provider, DestroyParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		}); err == nil {
			t.Fatal("expected the teardown mint refusal with no injected Talos minter")
		}
	})

	t.Run("deregisters the vcluster and its ArgoCD cluster Secret", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		vc := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
		var out strings.Builder
		if err := runVClusterDestroy(t.Context(), provider, DestroyParams{
			ProjectConfig:   vc,
			Provider:        "hetzner",
			TalosKubeconfig: depTalosMinter("apiVersion: v1\nkind: Config\n"),
			Stdout:          &out, Stderr: &out,
		}); err != nil {
			t.Fatalf("vcluster teardown: %v\n%s", err, out.String())
		}
		depContains(t, out.String(), "Deregistering vcluster", "vcluster deregister")
	})
}

// TestDep_DeregisterVClusterIsBestEffort pins the orphan-reclaim safety of the teardown: a failed
// helm uninstall must NOT stop the ArgoCD cluster-Secret delete (a leaked Secret keeps a dead
// vcluster registered), and the first error is the one returned.
func TestDep_DeregisterVClusterIsBestEffort(t *testing.T) {
	depIsolateHome(t)
	depFakeBins(t, "kubectl", "helm")
	spec := VClusterSpec{
		Name:                "tenant-a",
		HostNamespace:       "vcluster-tenant-a",
		ServiceAccount:      "vcluster-argocd-tenant-a",
		KubeconfigSecret:    "vcluster-kubeconfig-tenant-a",
		KubeconfigNamespace: "argocd",
	}

	t.Run("a helm uninstall failure still runs the ArgoCD deregister", func(t *testing.T) {
		depFailExec(t, "uninstall", 1)
		var out strings.Builder
		err := deregisterVCluster(t.Context(), NewVClusterProvisioner(), spec, &out, &out)
		if err == nil {
			t.Fatal("expected the helm uninstall failure to be returned")
		}
		depContains(t, out.String(), "Deregistering vcluster tenant-a from ArgoCD", "ArgoCD deregister still ran")
	})

	t.Run("an ArgoCD deregister failure is surfaced", func(t *testing.T) {
		// DeregisterVClusterClusterSecret shells kubectl directly (not through the provisioner's
		// seam), so this failure is injected at the stub binary.
		t.Setenv("COV_KUBECTL_FAIL", "*delete secret tenant-a -n argocd*")
		var out strings.Builder
		if err := deregisterVCluster(t.Context(), NewVClusterProvisioner(), spec, &out, &out); err == nil {
			t.Fatal("expected the ArgoCD cluster-Secret deregister failure to be returned")
		}
	})
}

// TestDep_PlacementMintNameKeyFailsClosed pins the defence-in-depth guard behind
// selectPlacementPath: a cloud that is activated in the re-mint allowlist but has NO cluster-name
// output key must refuse, not mint a nameless kubeconfig. The allowlists and the key map are kept
// in step by construction today, so the branch is only reachable by desynchronising them — which
// is exactly the mistake the guard exists to catch.
func TestDep_PlacementMintNameKeyFailsClosed(t *testing.T) {
	const bogus = "cov-cloud"
	namespaceRemintProviders[bogus] = true
	vclusterRemintProviders[bogus] = true
	t.Cleanup(func() {
		delete(namespaceRemintProviders, bogus)
		delete(vclusterRemintProviders, bogus)
	})

	if err := mintNamespaceKubeAccess(t.Context(), nil, nil, nil, nil, bogus, "c", io.Discard); err == nil {
		t.Error("namespace mint with no cluster-name output key = nil, want a fail-closed error")
	}
	if err := mintVClusterHostAccess(t.Context(), nil, nil, nil, nil, bogus, "c", io.Discard); err == nil {
		t.Error("vcluster host mint with no cluster-name output key = nil, want a fail-closed error")
	}

	// And the mint-output error propagates through both seams (hetzner without an injected minter).
	if err := mintNamespaceKubeAccess(t.Context(), nil, nil, nil, nil, "hetzner", "c", io.Discard); err == nil {
		t.Error("namespace mint without a Talos minter = nil, want a wiring-bug error")
	}
	if err := mintVClusterHostAccess(t.Context(), nil, nil, nil, nil, "hetzner", "c", io.Discard); err == nil {
		t.Error("vcluster host mint without a Talos minter = nil, want a wiring-bug error")
	}
}

// TestDep_NewCloudProviderFailsClosedOnPlacementLanes pins the defence-in-depth construction guard
// on both placement lanes: a cloud that is activated in the re-mint allowlist but that
// cloud.NewCloudProvider refuses must surface that refusal, not proceed provider-less.
func TestDep_NewCloudProviderFailsClosedOnPlacementLanes(t *testing.T) {
	const comingSoon = "digitalocean" // connectable, but provisioning is not wired
	namespaceRemintProviders[comingSoon] = true
	vclusterRemintProviders[comingSoon] = true
	t.Cleanup(func() {
		delete(namespaceRemintProviders, comingSoon)
		delete(vclusterRemintProviders, comingSoon)
	})

	nsCfg := depPlacementConfig(types.PlacementModeNamespace, "team-web")
	var out strings.Builder
	if _, err := runNamespaceDeploy(t.Context(), DeployParams{
		ProjectConfig: nsCfg, Provider: comingSoon, Stdout: &out, Stderr: &out,
	}); err == nil {
		t.Error("namespace lane with an unconstructable provider = nil, want the provider error")
	}

	vcCfg := depPlacementConfig(types.PlacementModeVcluster, "tenant-a")
	if _, err := runVClusterDeploy(t.Context(), DeployParams{
		ProjectConfig: vcCfg, Provider: comingSoon, Stdout: &out, Stderr: &out,
	}); err == nil {
		t.Error("vcluster lane with an unconstructable provider = nil, want the provider error")
	}
}

// TestDep_RunDeployV2PreflightRefusals pins every refusal RunDeployV2 makes BEFORE it constructs a
// tofu CLI: a missing config, a cross-cloud CORE placement, an unprovisionable cloud, missing
// cluster tooling, an unusable temp root, an unreadable template dir and no IaC source at all.
func TestDep_RunDeployV2PreflightRefusals(t *testing.T) {
	t.Run("nil ProjectConfig", func(t *testing.T) {
		if _, err := RunDeployV2(t.Context(), DeployParams{}); err == nil {
			t.Fatal("RunDeployV2 with no ProjectConfig = nil, want a refusal")
		}
	})

	t.Run("cross-cloud CORE placement is gated", func(t *testing.T) {
		vc := newLocalProjectConfig("alethia", "gate")
		vc.CloudIdentityID = "primary"
		vc.Cluster.Placement = types.Placement{CloudIdentityID: "other-cloud"}
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "hetzner", Stdout: &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("a CORE resource on a foreign cloud identity must be gated")
		}
		depContains(t, err.Error(), "cross-cloud", "placement gate")
	})

	t.Run("unprovisionable cloud", func(t *testing.T) {
		vc := newLocalProjectConfig("alethia", "soon")
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "digitalocean", Stdout: &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("a cloud without provisioning templates must be refused")
		}
		depContains(t, err.Error(), "coming soon", "unprovisionable cloud")
	})

	t.Run("missing cluster tooling, with nil writers", func(t *testing.T) {
		t.Setenv("PATH", t.TempDir()) // no kubectl/helm
		vc := newLocalProjectConfig("alethia", "tools")
		// Nil Stdout/Stderr: the spine must fall back to the process streams rather than panic.
		_, err := RunDeployV2(t.Context(), DeployParams{ProjectConfig: vc, Provider: "aws"})
		if err == nil {
			t.Fatal("a real apply without kubectl/helm must fail preflight")
		}
		depContains(t, err.Error(), "preflight check failed", "cluster tooling preflight")
	})

	t.Run("unusable temp root", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "nope"))
		vc := newLocalProjectConfig("alethia", "tmp")
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "aws", Stdout: &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("an unusable temp root must fail the deploy")
		}
		depContains(t, err.Error(), "temp dir", "temp root")
	})

	t.Run("unreadable templates dir", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		vc := newLocalProjectConfig("alethia", "tpl")
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "aws",
			TemplatesDir: filepath.Join(t.TempDir(), "missing"),
			Stdout:       &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("a templates dir that does not exist must fail the deploy")
		}
		depContains(t, err.Error(), "failed to copy templates", "templates copy")
	})

	t.Run("no IaC source at all", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		vc := newLocalProjectConfig("alethia", "noiac")
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "aws", Stdout: &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("neither IacSource nor TemplatesDir must be refused")
		}
		depContains(t, err.Error(), "no IaC source", "no IaC source")
	})

	t.Run("no usable OpenTofu binary", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		// No tofu on PATH AND no resolvable home: the binary resolver fails WITHOUT reaching for
		// the network (which is the only other way it could obtain one).
		t.Setenv("PATH", filepath.Join(t.TempDir(), "empty"))
		depFakeBins(t, "kubectl", "helm")
		t.Setenv("HOME", "")
		vc := newLocalProjectConfig("alethia", "notofu")
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "aws",
			TemplatesDir: depWriteModule(t, depClusterModuleTF),
			Stdout:       &out, Stderr: &out,
		})
		if err == nil {
			t.Fatal("an unresolvable OpenTofu binary must fail the deploy")
		}
		depContains(t, err.Error(), "tofu init failed", "tofu binary")
	})
}

// TestDep_BrownfieldNetworkTfvars pins the brownfield attach: on gcp and azure the existing
// network id is passed straight through as a tfvar (the template data-sources the subnet), and no
// cloud call is made to get there. The refusal that follows (no StateBackend) is the next gate.
func TestDep_BrownfieldNetworkTfvars(t *testing.T) {
	depRequireTofu(t)
	for _, tc := range []struct{ provider, marker string }{
		{"gcp", "Using existing VPC network"},
		{"azure", "Using existing VNet"},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			depFakeBins(t, "kubectl", "helm")
			vc := newLocalProjectConfig("alethia", "bf")
			vc.Network.ProvisionNetwork = false
			vc.Network.NetworkID = "existing-network-id"
			var out strings.Builder
			_, err := RunDeployV2(t.Context(), DeployParams{
				ProjectConfig: vc, Provider: tc.provider,
				TemplatesDir: depWriteModule(t, depClusterModuleTF),
				Stdout:       &out, Stderr: &out,
				// StateBackend deliberately nil: state storage is the very next gate, so this
				// stops right after the brownfield tfvars are computed.
			})
			if err == nil {
				t.Fatal("a deploy without a StateBackend must be refused")
			}
			depContains(t, err.Error(), "StateBackend", "state backend gate")
			depContains(t, out.String(), tc.marker, "brownfield attach")
		})
	}
}

// TestDep_ApplyBootstrapManifestsRefusals pins the CNI-bootstrap step: no manifest is a no-op
// (managed clusters emit none), an unusable temp root is an error, and a cancelled context stops
// the retry loop instead of burning the whole budget.
func TestDep_ApplyBootstrapManifestsRefusals(t *testing.T) {
	if err := applyBootstrapManifests(t.Context(), map[string]interface{}{}, io.Discard, io.Discard); err != nil {
		t.Errorf("no bootstrap_manifests output = %v, want a no-op nil (managed cluster)", err)
	}

	outputs := map[string]interface{}{"bootstrap_manifests": "kind: Namespace\n"}
	t.Run("unusable temp root", func(t *testing.T) {
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "nope"))
		if err := applyBootstrapManifests(t.Context(), outputs, io.Discard, io.Discard); err == nil {
			t.Error("applyBootstrapManifests with an unusable TMPDIR = nil, want an error")
		}
	})

	t.Run("cancelled context stops the retry loop", func(t *testing.T) {
		depFailExec(t, "apply --server-side", 1)
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if err := applyBootstrapManifests(ctx, outputs, io.Discard, io.Discard); err == nil {
			t.Error("a cancelled context = nil, want the cancellation surfaced")
		}
	})
}

// TestDep_InstallArgoCDStepRefusals pins the ArgoCD install's fail-closed steps: the helm repo, the
// pre-seeded redis secret, an unusable values scratch dir, and — on the GKE ingress lane — the
// Cloud Armor BackendConfig apply, which is deliberately FATAL (a public ingress with the policy
// silently unattached is worse than not deploying).
func TestDep_InstallArgoCDStepRefusals(t *testing.T) {
	vc := newLocalProjectConfig("alethia", "argo")

	t.Run("helm repo add fails", func(t *testing.T) {
		depFailExec(t, "helm repo add", 1)
		var result PlanResult
		if err := installArgoCD(t.Context(), vc, nil, &result, io.Discard, io.Discard); err == nil {
			t.Error("a failed `helm repo add` = nil, want the install refused")
		}
	})

	t.Run("redis secret pre-seed fails", func(t *testing.T) {
		depFailExec(t, "create namespace argocd", 1)
		var result PlanResult
		err := installArgoCD(t.Context(), vc, nil, &result, io.Discard, io.Discard)
		if err == nil {
			t.Fatal("a failed redis pre-seed = nil, want the install refused")
		}
		depContains(t, err.Error(), "argocd-redis", "redis pre-seed")
	})

	t.Run("unusable values scratch dir", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "nope"))
		var result PlanResult
		if err := installArgoCD(t.Context(), vc, nil, &result, io.Discard, io.Discard); err == nil {
			t.Error("an unusable values scratch dir = nil, want the install refused")
		}
	})

	t.Run("GKE Cloud Armor BackendConfig apply is fatal", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		gke := newLocalProjectConfig("alethia", "armor")
		gke.Provider = types.CloudProviderGcp
		gke.CloudAccountID = "cov-project"
		gke.DNS.Enabled = true
		gke.DNS.DomainName = "cov.example"
		gke.DNS.ManagedCertificate = true
		outputs := map[string]interface{}{
			"gke_cluster_name":             "cov-gke",
			"cloud_armor_policy_name":      "cov-armor",
			"external_dns_service_account": "edns@cov-project.iam.gserviceaccount.com",
			"cloud_dns_zone_name":          "cov-zone",
		}
		depFailExec(t, "backendconfig.yaml", 1)
		var result PlanResult
		err := installArgoCD(t.Context(), gke, outputs, &result, io.Discard, io.Discard)
		if err == nil {
			t.Fatal("a failed Cloud Armor BackendConfig apply = nil, want the install refused")
		}
		depContains(t, err.Error(), "Cloud Armor BackendConfig", "cloud armor")
	})
}

// TestDep_EnsureArgoRedisSecretRefusals pins the redis pre-seed: the namespace ensure and the
// secret apply are both hard errors, and an unusable temp root is too — a silently skipped
// pre-seed is what let the chart's flaky hook block whole installs.
func TestDep_EnsureArgoRedisSecretRefusals(t *testing.T) {
	t.Run("namespace ensure fails", func(t *testing.T) {
		depFailExec(t, "create namespace argocd", 1)
		if err := ensureArgoRedisSecret(io.Discard, io.Discard); err == nil {
			t.Error("a failed namespace ensure = nil, want an error")
		}
	})

	t.Run("unusable temp root", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "nope"))
		if err := ensureArgoRedisSecret(io.Discard, io.Discard); err == nil {
			t.Error("an unusable TMPDIR = nil, want an error")
		}
	})

	t.Run("secret apply fails", func(t *testing.T) {
		depFakeBins(t, "kubectl", "helm")
		depFailExec(t, "argocd-redis.yaml", 1)
		if err := ensureArgoRedisSecret(io.Discard, io.Discard); err == nil {
			t.Error("a failed secret apply = nil, want an error")
		}
	})

	t.Run("an existing auth is left untouched", func(t *testing.T) {
		orig := executeCommandWithOutput
		executeCommandWithOutput = func(string, string, []string) (string, error) { return "cHJlc2V0\n", nil }
		t.Cleanup(func() { executeCommandWithOutput = orig })
		depFakeBins(t, "kubectl", "helm")
		var out strings.Builder
		if err := ensureArgoRedisSecret(&out, io.Discard); err != nil {
			t.Fatalf("existing redis auth: %v", err)
		}
		depContains(t, out.String(), "leaving its auth untouched", "idempotent redis pre-seed")
	})
}

// TestDep_CopyDirSurfacesIOErrors pins that copyDir reports an unreadable source file rather than
// silently producing a partial template tree (a half-copied module plans against the wrong graph).
func TestDep_CopyDirSurfacesIOErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: file-mode permissions are not enforced")
	}
	src := t.TempDir()
	unreadable := filepath.Join(src, "secret.tf")
	if err := os.WriteFile(unreadable, []byte("x"), 0o000); err != nil {
		t.Fatal(err)
	}
	if err := copyDir(src, filepath.Join(t.TempDir(), "dst")); err == nil {
		t.Error("copyDir over an unreadable file = nil, want the IO error surfaced")
	}
}

// TestDep_RunnerIdentityPrefersTheInjectedInstanceID pins the receipt's executor field: the
// runner's instance id wins, and the hostname is the fallback — never an empty attribution.
func TestDep_RunnerIdentityPrefersTheInjectedInstanceID(t *testing.T) {
	t.Setenv("ALETHIA_RUNNER_INSTANCE_ID", "runner-42")
	if got := runnerIdentity(); got != "runner-42" {
		t.Errorf("runnerIdentity() = %q, want the injected instance id", got)
	}
	t.Setenv("ALETHIA_RUNNER_INSTANCE_ID", "")
	if got := runnerIdentity(); got == "" {
		t.Error("runnerIdentity() = \"\", want the hostname fallback")
	}
}

// TestDep_AttachReceiptSigning pins the evidence receipt: no report means no receipt, an invalid
// signing key degrades to an UNSIGNED receipt with a warning (never a silent drop), and a valid
// key produces an ed25519-signed one sealed to the plan bytes.
func TestDep_AttachReceiptSigning(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "tofu.plan.out")
	if err := os.WriteFile(planFile, []byte("plan-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	report := &verify.Report{Verdict: verify.StatusPass, CatalogVersion: "cov"}

	t.Run("no report, no receipt", func(t *testing.T) {
		var result PlanResult
		attachReceipt(&result, planFile, nil, nil, io.Discard)
		if result.VerifyReceipt != nil {
			t.Error("a nil report produced a receipt — there is nothing to seal")
		}
	})

	t.Run("an invalid signing key degrades to unsigned", func(t *testing.T) {
		t.Setenv(verify.SigningKeyEnv, "not-base64!!")
		var out strings.Builder
		result := PlanResult{VerifyReport: report}
		attachReceipt(&result, planFile, nil, nil, &out)
		if result.VerifyReceipt == nil || result.VerifyReceipt.Algorithm != "none" {
			t.Fatalf("want an unsigned receipt, got %+v", result.VerifyReceipt)
		}
		depContains(t, out.String(), "signing key invalid", "invalid key warning")
	})

	t.Run("a valid key signs the receipt", func(t *testing.T) {
		priv, pub := genEd25519(t)
		t.Setenv(verify.SigningKeyEnv, base64.StdEncoding.EncodeToString(priv))
		var out strings.Builder
		result := PlanResult{VerifyReport: report}
		attachReceipt(&result, planFile, nil, nil, &out)
		if result.VerifyReceipt == nil || result.VerifyReceipt.Algorithm != "ed25519" {
			t.Fatalf("want an ed25519 receipt, got %+v", result.VerifyReceipt)
		}
		if err := result.VerifyReceipt.Verify(pub); err != nil {
			t.Errorf("receipt signature does not verify: %v", err)
		}
		depContains(t, out.String(), "Evidence receipt signed", "signed receipt log")
	})
}

// TestDep_ResolveArgoTemplatesDirSkipsEmptyCandidates pins the resolver's contract: an unset
// override is skipped rather than stat'ed as "", and a non-existent one resolves to "" so the
// caller can fail closed on a runner image missing its baked templates.
func TestDep_ResolveArgoTemplatesDirSkipsEmptyCandidates(t *testing.T) {
	t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", "")
	if got := resolveArgoTemplatesDir(); got != "" {
		t.Errorf("resolveArgoTemplatesDir() = %q, want \"\" when no candidate exists", got)
	}
	dir := t.TempDir()
	t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", dir)
	if got := resolveArgoTemplatesDir(); got != dir {
		t.Errorf("resolveArgoTemplatesDir() = %q, want the override %q", got, dir)
	}
}

// TestDep_ReadGitopsSnapshotModes pins the honest wiring report: direct mode is just the marker,
// and gitops mode reads the apps Application back (an unreadable status reports Unknown, never a
// fabricated pass).
func TestDep_ReadGitopsSnapshotModes(t *testing.T) {
	depFakeBins(t, "kubectl")
	if got := readGitopsSnapshot(false, "", io.Discard, io.Discard); got.Mode != "direct" {
		t.Errorf("mode = %q, want direct", got.Mode)
	}
	got := readGitopsSnapshot(true, "https://github.com/acme/apps.git", io.Discard, io.Discard)
	if got.Mode != "gitops" || got.AppsRepo == "" || got.AppHealth == nil {
		t.Errorf("gitops snapshot = %+v, want mode+repo+health recorded", got)
	}
}

// depSpineParams builds the DeployParams for a real-tofu spine run against an isolated state server.
func depSpineParams(t *testing.T, vc *types.ProjectConfig, module string, out io.Writer) DeployParams {
	t.Helper()
	srv := startTestStateServer(t)
	modDir := depWriteModule(t, module)
	params := DeployParams{
		ProjectConfig: vc,
		Provider:      "hetzner",
		TemplatesDir:  modDir,
		StateBackend:  testStateBackend(srv),
		Stdout:        out,
		Stderr:        out,
	}
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer dcancel()
		if derr := RunDestroy(dctx, DestroyParams{
			ProjectConfig: vc, Provider: "hetzner", TemplatesDir: modDir,
			StateBackend: testStateBackend(srv), Stdout: io.Discard, Stderr: io.Discard,
		}); derr != nil {
			t.Logf("teardown (non-fatal): %v", derr)
		}
	})
	return params
}

// TestDep_SpineGitOpsAndAddOns drives the second half of the post-apply spine that the bare
// cluster run never reaches: an apps-destination repo with a token (ArgoCD repo credentials +
// manifest generation) and an enabled marketplace add-on (the operator wave, the secret seeding,
// the Application render/apply in sync-wave order, the GitOps sync and the health read-back).
func TestDep_SpineGitOpsAndAddOns(t *testing.T) {
	depRequireTofu(t)
	depIsolateHome(t)
	depFakeBins(t, "kubectl", "helm", "git")
	depArgoTemplates(t)
	depNoSlowProbes(t)

	vc := newLocalProjectConfig("alethia", "cova"+shortID(t))
	vc.Repositories.AppsDestinationRepo = "https://github.com/acme/apps.git"
	vc.AddOns = []types.AddOnInstall{{
		ID:        "grafana",
		Mode:      "managed",
		Namespace: "monitoring",
		Version:   "8.5.0",
	}}

	var out strings.Builder
	params := depSpineParams(t, vc, depClusterModuleTF, &out)
	params.GitAccessToken = "ghp_cov"
	params.AddOnSecretValues = map[string]map[string]string{"grafana": {"adminPassword": "cov"}}

	result, err := RunDeployV2(t.Context(), params)
	if err != nil {
		t.Fatalf("RunDeployV2 (gitops + add-ons): %v\n%s", err, out.String())
	}
	if result.GitopsStatus == nil || result.GitopsStatus.Mode != "gitops" {
		t.Fatalf("GitopsStatus = %+v, want gitops mode with the apps repo recorded", result.GitopsStatus)
	}
	depContains(t, out.String(), "ArgoCD repository credentials", "apps-repo credential")
	if result.AddOnStatus == nil {
		t.Error("AddOnStatus is nil — the add-on health read-back did not run for an enabled add-on")
	}
}

// TestDep_SpinePlanJobs pins the plan (dry-run) half of the spine: a real plan attaches the plan
// bytes plus an advisory receipt, and a PRE-APPROVED plan file skips the re-plan — in which case
// the verification gate honestly reports a coverage gap instead of a pass it never computed.
func TestDep_SpinePlanJobs(t *testing.T) {
	depRequireTofu(t)

	t.Run("dry-run attaches the plan bytes and an advisory receipt", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		vc := newLocalProjectConfig("alethia", "covp"+shortID(t))
		var out strings.Builder
		params := depSpineParams(t, vc, depClusterModuleTF, &out)
		params.DryRun = true
		result, err := RunDeployV2(t.Context(), params)
		if err != nil {
			t.Fatalf("dry-run: %v\n%s", err, out.String())
		}
		if len(result.PlanFileBytes) == 0 {
			t.Error("PlanFileBytes is empty — the plan job did not attach the plan")
		}
		if result.VerifyReceipt == nil {
			t.Error("VerifyReceipt is nil — a plan job gets an advisory receipt too")
		}
	})

	t.Run("a pre-approved plan file skips the re-plan and reports the gate gap", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		vc := newLocalProjectConfig("alethia", "covq"+shortID(t))
		var out strings.Builder
		params := depSpineParams(t, vc, depClusterModuleTF, &out)
		params.DryRun = true
		params.PlanFile = filepath.Join(t.TempDir(), "approved.plan")
		result, err := RunDeployV2(t.Context(), params)
		if err != nil {
			t.Fatalf("pre-approved plan dry-run: %v\n%s", err, out.String())
		}
		depContains(t, out.String(), "pre-approved plan file", "plan reuse")
		depContains(t, out.String(), "Verification gate: SKIPPED", "honest coverage gap")
		if result.VerifyReport != nil {
			t.Error("VerifyReport is non-nil with no plan JSON — the gate must not fabricate a verdict")
		}
	})
}

// TestDep_SpineApplyGates pins the three fail-closed gates that stand between a plan and a real
// apply: the cost ceiling, the missing-verdict backstop, and — once an authorized override waives
// the missing verdict — the apply itself, whose failure is classified rather than swallowed.
func TestDep_SpineApplyGates(t *testing.T) {
	depRequireTofu(t)

	t.Run("cost ceiling blocks an unpriced apply", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		vc := newLocalProjectConfig("alethia", "covc"+shortID(t))
		var out strings.Builder
		params := depSpineParams(t, vc, depClusterModuleTF, &out)
		params.CostCeilingMonthlyUSD = 0.01
		_, err := RunDeployV2(t.Context(), params)
		if err == nil {
			t.Fatal("an apply that could not be priced must be blocked by a configured ceiling")
		}
	})

	t.Run("no verdict refuses the apply", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		vc := newLocalProjectConfig("alethia", "covn"+shortID(t))
		var out strings.Builder
		params := depSpineParams(t, vc, depClusterModuleTF, &out)
		params.PlanFile = filepath.Join(t.TempDir(), "approved.plan") // no plan JSON → no verdict
		_, err := RunDeployV2(t.Context(), params)
		if err == nil {
			t.Fatal("a real apply with no verification verdict must be refused")
		}
		depContains(t, err.Error(), "refusing apply", "fail-closed backstop")
	})

	t.Run("an authorized override proceeds, and the apply failure is reported", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		vc := newLocalProjectConfig("alethia", "covo"+shortID(t))
		var out strings.Builder
		params := depSpineParams(t, vc, depClusterModuleTF, &out)
		params.PlanFile = filepath.Join(t.TempDir(), "approved.plan")
		params.VerifyOverride = &verify.Override{
			By:     "cov-operator",
			Reason: "coverage probe",
			// The backstop sentinel is waivable ONLY by a time-boxed override: a zero Expiry is
			// refused by verify.Override.Covers, so an override without one never reaches the apply.
			Expiry:   time.Now().Add(time.Hour),
			Controls: []string{verify.ControlPlanUnavailable},
		}
		_, err := RunDeployV2(t.Context(), params)
		if err == nil {
			t.Fatal("applying a non-existent plan file must fail")
		}
		depContains(t, out.String(), "Verification override applied", "override audit line")
		depContains(t, err.Error(), "tofu apply failed", "apply failure")
	})
}

// TestDep_SpinePostApplyFailuresAreFatal pins the post-apply half's fail-closed contract: a
// provisioned cluster that cannot be reached, wired or bootstrapped FAILS the job. "tofu apply
// exited 0" is never allowed to read as a working cluster.
func TestDep_SpinePostApplyFailuresAreFatal(t *testing.T) {
	depRequireTofu(t)

	// A cluster module with NO kubeconfig output: ConfigureKubeconfig cannot write one.
	noKubeconfigModule := strings.Replace(depClusterModuleTF,
		`output "kubeconfig" {
  value = "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n"
}`, "", 1)

	t.Run("kubeconfig cannot be configured", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		vc := newLocalProjectConfig("alethia", "covk"+shortID(t))
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), depSpineParams(t, vc, noKubeconfigModule, &out))
		if err == nil {
			t.Fatal("a cluster with no kubeconfig must fail the deploy, not report success")
		}
		depContains(t, err.Error(), "is unreachable", "kubeconfig failure")
	})

	t.Run("CNI bootstrap never converges", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		depFailExec(t, "apply --server-side", 1)
		ctx, cancel := context.WithCancel(t.Context())
		vc := newLocalProjectConfig("alethia", "covb"+shortID(t))
		var out strings.Builder
		params := depSpineParams(t, vc, depClusterModuleTF, &out)
		// Cancel only once the bootstrap retry loop is the thing waiting: the loop honours ctx,
		// so this stops it immediately instead of burning the 4×15s retry budget.
		orig := executeCommand
		executeCommand = func(cmd, dir string, env []string, o, e io.Writer) error {
			if strings.Contains(cmd, "apply --server-side") {
				cancel()
			}
			return orig(cmd, dir, env, o, e)
		}
		t.Cleanup(func() { executeCommand = orig })
		_, err := RunDeployV2(ctx, params)
		if err == nil {
			t.Fatal("a failed CNI bootstrap must fail the deploy")
		}
	})

	t.Run("cluster never becomes reachable", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		t.Setenv("COV_KUBECTL_FAIL", "get --raw*")
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "1ms")
		vc := newLocalProjectConfig("alethia", "covr"+shortID(t))
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), depSpineParams(t, vc, depClusterModuleTF, &out))
		if err == nil {
			t.Fatal("an unreachable cluster must fail the deploy")
		}
		depContains(t, err.Error(), "not reachable", "reachability gate")
	})

	t.Run("the pod datapath is broken", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		t.Setenv("ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE", "") // run the in-cluster probe
		t.Setenv("COV_KUBECTL_FAIL", "get svc kubernetes*")
		vc := newLocalProjectConfig("alethia", "covd"+shortID(t))
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), depSpineParams(t, vc, depClusterModuleTF, &out))
		if err == nil {
			t.Fatal("a broken pod->apiserver datapath must fail the deploy")
		}
		depContains(t, err.Error(), "pod network is broken", "datapath gate")
	})

	t.Run("ArgoCD install fails", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		t.Setenv("COV_TOOL_FAIL", "repo add argo*")
		vc := newLocalProjectConfig("alethia", "covi"+shortID(t))
		vc.Repositories.AppsDestinationRepo = "https://github.com/acme/apps.git"
		var out strings.Builder
		params := depSpineParams(t, vc, depClusterModuleTF, &out)
		params.GitAccessToken = "ghp_cov"
		result, err := RunDeployV2(t.Context(), params)
		if err == nil {
			t.Fatal("a failed ArgoCD install must fail the deploy")
		}
		if result == nil || result.GitopsStatus == nil || result.GitopsStatus.FailedStep == "" {
			t.Fatalf("want a partial result naming the failed GitOps step, got %+v", result)
		}
	})

	t.Run("the runner image is missing its baked ArgoCD templates", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", "")
		vc := newLocalProjectConfig("alethia", "covt"+shortID(t))
		var out strings.Builder
		result, err := RunDeployV2(t.Context(), depSpineParams(t, vc, depClusterModuleTF, &out))
		if err == nil {
			t.Fatal("missing baked templates must fail the deploy, not silently skip infra services")
		}
		depContains(t, err.Error(), "templates not found", "templates missing")
		if result == nil || result.GitopsStatus == nil {
			t.Fatal("want a partial result carrying the templates-missing step")
		}
	})

	t.Run("an infra-service template cannot be rendered", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		bad := t.TempDir()
		if err := os.WriteFile(filepath.Join(bad, "broken.yaml"), []byte("{{ .Unterminated "), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", bad)
		vc := newLocalProjectConfig("alethia", "covx"+shortID(t))
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), depSpineParams(t, vc, depClusterModuleTF, &out))
		if err == nil {
			t.Fatal("an unrenderable infra-service template must fail the deploy")
		}
		depContains(t, err.Error(), "render ArgoCD applications", "render step")
	})

	t.Run("the infra-service applications cannot be applied", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depArgoTemplates(t)
		depNoSlowProbes(t)
		t.Setenv("COV_KUBECTL_FAIL", "*argocd-apps-*")
		vc := newLocalProjectConfig("alethia", "covy"+shortID(t))
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), depSpineParams(t, vc, depClusterModuleTF, &out))
		if err == nil {
			t.Fatal("a failed infra-service apply must fail the deploy")
		}
		depContains(t, err.Error(), "infrastructure applications", "apply step")
	})
}

// ── AWS brownfield, the pluggable-connector seeding tail, and the two gate lanes ──
//
// Everything below stays offline. The AWS lane is driven by a FAKE EC2 endpoint
// (AWS_ENDPOINT_URL_EC2 + static dummy credentials), which is what makes the brownfield
// subnet classification — the one branch of the network attach that talks to a cloud —
// testable at all; the alternative was a live DescribeSubnets.

// depSubnetsXML is the ec2query DescribeSubnets response for the brownfield VPC: one public and
// one private subnet. EVERY field ListSubnets dereferences is present — a missing one would nil-
// panic the client inside the SDK rather than fail the assertion.
const depSubnetsXML = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSubnetsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>cov-req</requestId>
  <subnetSet>
    <item>
      <subnetId>subnet-cov-public</subnetId>
      <cidrBlock>10.0.1.0/24</cidrBlock>
      <availabilityZone>eu-central-1a</availabilityZone>
      <vpcId>vpc-cov</vpcId>
      <mapPublicIpOnLaunch>true</mapPublicIpOnLaunch>
    </item>
    <item>
      <subnetId>subnet-cov-private</subnetId>
      <cidrBlock>10.0.2.0/24</cidrBlock>
      <availabilityZone>eu-central-1b</availabilityZone>
      <vpcId>vpc-cov</vpcId>
      <mapPublicIpOnLaunch>false</mapPublicIpOnLaunch>
    </item>
  </subnetSet>
</DescribeSubnetsResponse>
`

// depEC2ErrorXML is a NON-retryable EC2 client error, so the failing lookup costs one round trip
// rather than the SDK's retry budget.
const depEC2ErrorXML = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Errors><Error><Code>InvalidVpcID.NotFound</Code><Message>cov: no such vpc</Message></Error></Errors><RequestID>cov-req</RequestID></Response>
`

// depFakeEC2 serves one canned ec2query response on every path and returns its base URL.
func depFakeEC2(t *testing.T, status int, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/xml")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// depAWSEnv neutralises every ambient AWS input (this host has real credentials and a shared
// config; CI has neither) and points the SDK at `endpoint`. Static dummy credentials keep the
// signer off IMDS, and one attempt keeps a deliberate failure fast.
func depAWSEnv(t *testing.T, endpoint string) {
	t.Helper()
	none := filepath.Join(t.TempDir(), "absent")
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIACOVERAGETEST")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "cov-secret")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_REGION", "eu-central-1")
	t.Setenv("AWS_DEFAULT_REGION", "eu-central-1")
	t.Setenv("AWS_PROFILE", "")
	t.Setenv("AWS_CONFIG_FILE", none)
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", none)
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_MAX_ATTEMPTS", "1")
	t.Setenv("AWS_ENDPOINT_URL", endpoint)
	t.Setenv("AWS_ENDPOINT_URL_EC2", endpoint)
}

// depBrokenAWSConfig points the SDK's shared-config loader at a file that is not INI, so
// LoadDefaultConfig FAILS. That is the only offline way to reach the two "the AWS SDK could not
// even be configured" branches, which are otherwise dead code under test.
func depBrokenAWSConfig(t *testing.T) {
	t.Helper()
	bad := filepath.Join(t.TempDir(), "broken-config")
	if err := os.WriteFile(bad, []byte("this line is not ini and has no equals sign\n"), 0o600); err != nil {
		t.Fatalf("write broken aws config: %v", err)
	}
	t.Setenv("AWS_CONFIG_FILE", bad)
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", bad)
	t.Setenv("AWS_PROFILE", "cov-broken")
}

// TestDep_BrownfieldAwsSubnetResolution pins the AWS half of the brownfield network attach — the
// only branch of it that calls a cloud. Auto-discovery, an explicit subnet selection, a failed
// lookup that must NOT drop the selection, and an unconfigurable SDK: all four report what they
// did, and none of them may silently emit no subnet tfvars (the template's fail-closed brownfield
// precondition is the backstop, not the plan).
func TestDep_BrownfieldAwsSubnetResolution(t *testing.T) {
	depRequireTofu(t)

	// run drives RunDeployV2 as far as the StateBackend gate — the step immediately after the
	// brownfield tfvars are computed — and returns everything the deploy printed.
	run := func(t *testing.T, selection []string) string {
		t.Helper()
		depFakeBins(t, "kubectl", "helm")
		vc := newLocalProjectConfig("alethia", "bfaws")
		vc.Network.ProvisionNetwork = false
		vc.Network.NetworkID = "vpc-cov"
		vc.Network.SubnetIDs = selection
		var out strings.Builder
		_, err := RunDeployV2(t.Context(), DeployParams{
			ProjectConfig: vc, Provider: "aws",
			TemplatesDir: depWriteModule(t, depClusterModuleTF),
			Stdout:       &out, Stderr: &out,
			// StateBackend deliberately nil: it is the very next gate, so the run stops the
			// moment the brownfield block has done its work.
		})
		if err == nil {
			t.Fatalf("a deploy without a StateBackend must be refused\n%s", out.String())
		}
		depContains(t, err.Error(), "StateBackend", "state backend gate")
		depContains(t, out.String(), "Using existing VPC vpc-cov", "brownfield attach")
		return out.String()
	}

	t.Run("auto-discovers the VPC's subnets", func(t *testing.T) {
		depIsolateHome(t)
		depAWSEnv(t, depFakeEC2(t, http.StatusOK, depSubnetsXML))
		depContains(t, run(t, nil), "Found 1 private and 1 public subnets", "auto-discovery")
	})

	t.Run("honours an explicit subnet selection", func(t *testing.T) {
		depIsolateHome(t)
		depAWSEnv(t, depFakeEC2(t, http.StatusOK, depSubnetsXML))
		out := run(t, []string{"subnet-cov-public"})
		depContains(t, out, "from your 1-subnet selection", "explicit selection")
		if strings.Contains(out, "Found ") {
			t.Error("an explicit selection must not also report the auto-discovery message")
		}
	})

	t.Run("a failed lookup still honours the explicit selection", func(t *testing.T) {
		depIsolateHome(t)
		depAWSEnv(t, depFakeEC2(t, http.StatusBadRequest, depEC2ErrorXML))
		out := run(t, []string{"subnet-cov-public"})
		depContains(t, out, "failed to list subnets", "lookup warning")
		depContains(t, out, "from your 1-subnet selection", "selection survives the failed lookup")
	})

	t.Run("an unconfigurable SDK is reported, not swallowed", func(t *testing.T) {
		depIsolateHome(t)
		depAWSEnv(t, depFakeEC2(t, http.StatusOK, depSubnetsXML))
		depBrokenAWSConfig(t)
		depContains(t, run(t, nil), "failed to create EC2 client", "EC2 client warning")
	})
}

// TestDep_NamespaceIdentityCloudRefusals pins the two per-namespace identity lanes whose
// provisioner is a live cloud write (aws IRSA, alibaba RRSA): when the cloud call cannot be made
// the namespace lane FAILS, naming the namespace. It must never fall through to a namespace with
// no identity — that would hand the tenant the cluster-wide node role, which is the #957 defect.
func TestDep_NamespaceIdentityCloudRefusals(t *testing.T) {
	vc := depPlacementConfig(types.PlacementModeNamespace, "team-x")

	t.Run("aws", func(t *testing.T) {
		depIsolateHome(t)
		// A closed local port: the EKS lookup fails on the first round trip, offline and fast.
		depAWSEnv(t, "http://127.0.0.1:1")
		err := provisionAndBindNamespaceIdentity(t.Context(), nil, "aws", "eu-central-1", vc, "fabric-1", "team-x", io.Discard, io.Discard)
		if err == nil {
			t.Fatal("an unreachable IAM/EKS control plane must fail the namespace identity, not skip it")
		}
		depContains(t, err.Error(), "failed to provision per-namespace identity", "aws identity refusal")
	})

	t.Run("alibaba", func(t *testing.T) {
		// An empty region: the keyless ACS3 signing client refuses to build before any network I/O.
		err := provisionAndBindNamespaceIdentity(t.Context(), nil, "alibaba", "", vc, "fabric-1", "team-x", io.Discard, io.Discard)
		if err == nil {
			t.Fatal("an unbuildable Alibaba signing client must fail the namespace identity, not skip it")
		}
		depContains(t, err.Error(), "failed to provision per-namespace identity", "alibaba identity refusal")
	})
}

// depPlanSpineParams builds the params for a PLAN-ONLY spine run on an arbitrary provider. Nothing
// is applied, so no destroy teardown is owed and no cloud is ever reached.
func depPlanSpineParams(t *testing.T, vc *types.ProjectConfig, providerSlug, module string, out io.Writer) DeployParams {
	t.Helper()
	return DeployParams{
		ProjectConfig: vc,
		Provider:      providerSlug,
		TemplatesDir:  depWriteModule(t, module),
		StateBackend:  testStateBackend(startTestStateServer(t)),
		DryRun:        true,
		Stdout:        out,
		Stderr:        out,
	}
}

// TestDep_SpineAccessAnalyzerCorroboration pins the opt-in IAM Access Analyzer lane of the
// verification gate: on aws with the flag set the checker is wired into the evaluator and said so,
// and when the SDK cannot be configured at all the gate DEGRADES with a named warning rather than
// failing the plan — corroboration is additive, never load-bearing.
func TestDep_SpineAccessAnalyzerCorroboration(t *testing.T) {
	depRequireTofu(t)

	t.Run("enabled on aws", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		// A closed local port: the analyzer client is CONSTRUCTED but never usefully callable, so
		// nothing here can reach a real AWS endpoint even if a control tried.
		depAWSEnv(t, "http://127.0.0.1:1")
		t.Setenv("ALETHIA_VERIFY_ACCESS_ANALYZER", "1")
		vc := newLocalProjectConfig("alethia", "covaa")
		var out strings.Builder
		if _, err := RunDeployV2(t.Context(), depPlanSpineParams(t, vc, "aws", depClusterModuleTF, &out)); err != nil {
			t.Fatalf("plan with Access Analyzer enabled: %v\n%s", err, out.String())
		}
		depContains(t, out.String(), "Access Analyzer corroboration enabled", "analyzer wiring")
	})

	t.Run("an unconfigurable SDK degrades the corroboration, not the gate", func(t *testing.T) {
		depIsolateHome(t)
		depFakeBins(t, "kubectl", "helm")
		depNoSlowProbes(t)
		depAWSEnv(t, "http://127.0.0.1:1")
		depBrokenAWSConfig(t)
		t.Setenv("ALETHIA_VERIFY_ACCESS_ANALYZER", "1")
		vc := newLocalProjectConfig("alethia", "covab")
		var out strings.Builder
		result, err := RunDeployV2(t.Context(), depPlanSpineParams(t, vc, "aws", depClusterModuleTF, &out))
		if err != nil {
			t.Fatalf("a failed Access Analyzer setup must not fail the plan: %v\n%s", err, out.String())
		}
		depContains(t, out.String(), "Access Analyzer disabled", "degraded corroboration")
		if result.VerifyReport == nil {
			t.Error("VerifyReport is nil — the gate itself must still have run without corroboration")
		}
	})
}

// depFakeInfracostBinary plants a stub in the version-keyed cache path the Infracost wrapper
// checks FIRST, so ensureBinary finds it and the release download never happens. The stub writes
// the breakdown JSON the caller asked for to --out-file.
func depFakeInfracostBinary(t *testing.T, version string) {
	t.Helper()
	dir := filepath.Join(os.TempDir(), "alethia-infracost")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create infracost cache dir: %v", err)
	}
	path := filepath.Join(dir, "infracost_"+version)
	script := `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out-file" ]; then out="$2"; fi
  shift
done
[ -n "$out" ] || exit 1
cat > "$out" <<'BREAKDOWN'
{
  "version": "0.2",
  "currency": "USD",
  "totalMonthlyCost": "12.34",
  "totalHourlyCost": "0.0169",
  "diffTotalMonthlyCost": "0",
  "projects": [
    {
      "name": "cov",
      "breakdown": {
        "totalMonthlyCost": "12.34",
        "totalHourlyCost": "0.0169",
        "resources": [{"name": "terraform_data.noop", "monthlyCost": "12.34"}]
      }
    }
  ]
}
BREAKDOWN
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake infracost: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })
}

// TestDep_SpineInfracostBreakdown pins the cost-estimation lane of the plan: with a token the
// spine runs the breakdown over the plan JSON and ATTACHES it to the result, which is what the
// fail-closed cost ceiling on the apply path later reads. Without the attachment a configured
// ceiling blocks every apply, so "the estimate reached the result" is the contract.
func TestDep_SpineInfracostBreakdown(t *testing.T) {
	depRequireTofu(t)
	depIsolateHome(t)
	depFakeBins(t, "kubectl", "helm")
	depNoSlowProbes(t)

	version := "vcov" + shortID(t)
	t.Setenv("ALETHIA_INFRACOST_VERSION", version)
	depFakeInfracostBinary(t, version)

	vc := newLocalProjectConfig("alethia", "covic")
	var out strings.Builder
	params := depPlanSpineParams(t, vc, "hetzner", depClusterModuleTF, &out)
	params.InfracostToken = "cov-infracost-token"

	result, err := RunDeployV2(t.Context(), params)
	if err != nil {
		t.Fatalf("plan with an Infracost token: %v\n%s", err, out.String())
	}
	if result.CostBreakdown == nil {
		t.Fatalf("CostBreakdown is nil — the breakdown never reached the result\n%s", out.String())
	}
	if result.CostBreakdown.Summary == nil || result.CostBreakdown.Summary.TotalMonthly != 12.34 {
		t.Errorf("CostBreakdown.Summary = %+v, want the parsed 12.34 monthly total", result.CostBreakdown.Summary)
	}
}

// TestDep_SpineGitOpsNeedsACredentialOrAPublicRepo pins the fail-closed git gate on the dedicated
// lane: an apps repo that is neither token-backed nor anonymously cloneable FAILS the deploy, and
// records WHICH step died on the partial result. Silently skipping the wiring would report a
// successful deploy for a cluster ArgoCD can never sync.
func TestDep_SpineGitOpsNeedsACredentialOrAPublicRepo(t *testing.T) {
	depRequireTofu(t)
	depIsolateHome(t)
	depFakeBins(t, "kubectl", "helm", "git")
	depArgoTemplates(t)
	depNoSlowProbes(t)

	vc := newLocalProjectConfig("alethia", "covgt"+shortID(t))
	// A closed local port: the anonymous ref-advertisement probe fails on connect — no DNS, no
	// egress, and no chance of a real host answering 200 and flipping the branch.
	vc.Repositories.AppsDestinationRepo = "https://127.0.0.1:1/acme/apps.git"

	var out strings.Builder
	result, err := RunDeployV2(t.Context(), depSpineParams(t, vc, depClusterModuleTF, &out))
	if err == nil {
		t.Fatalf("a GitOps deploy with no token and no public repo must fail\n%s", out.String())
	}
	depContains(t, err.Error(), "no git access token is available", "git token gate")
	if result == nil || result.GitopsStatus == nil {
		t.Fatal("the partial result must carry a GitopsStatus naming the failed step")
	}
	if result.GitopsStatus.FailedStep != argocd.GitopsStepGitToken {
		t.Errorf("GitopsStatus.FailedStep = %q, want %q", result.GitopsStatus.FailedStep, argocd.GitopsStepGitToken)
	}
}

// depEcrIrsaModuleTF is depClusterModuleTF plus the pull-identity output the keyless Helm ECR
// refresher is gated on — without it the lane fail-closes and applies nothing.
var depEcrIrsaModuleTF = depClusterModuleTF + `
output "helm_repo_pull_irsa_arn" {
  value = "arn:aws:iam::123456789012:role/alethia-helm-repo-pull"
}
`
