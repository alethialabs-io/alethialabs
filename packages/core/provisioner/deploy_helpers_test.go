// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

func resetDeploySeams(t *testing.T) {
	t.Helper()
	origExecuteCommand := executeCommand
	origExecuteCommandWithOutput := executeCommandWithOutput
	t.Cleanup(func() {
		executeCommand = origExecuteCommand
		executeCommandWithOutput = origExecuteCommandWithOutput
	})
}

func TestDeployHelperPolicyFunctions(t *testing.T) {
	t.Run("enabled add-on ids preserve desired order", func(t *testing.T) {
		got := enabledAddonIDs([]types.AddOnInstall{{ID: "db"}, {ID: "cache"}, {ID: "queue"}})
		if strings.Join(got, ",") != "db,cache,queue" {
			t.Fatalf("enabledAddonIDs = %#v", got)
		}
	})

	t.Run("phase marker is best effort and optional", func(t *testing.T) {
		writePhase("", "apply")
		path := filepath.Join(t.TempDir(), "phase")
		writePhase(path, "apply")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read phase: %v", err)
		}
		if string(data) != "apply" {
			t.Fatalf("phase = %q, want apply", data)
		}
	})

	t.Run("gitops failure sanitizes token and records mode", func(t *testing.T) {
		status := gitopsFailure(true, "https://github.com/acme/apps.git", "repo_credentials", errors.New("clone failed with secret-token"), "secret-token")
		if status.Mode != "gitops" || status.AppsRepo != "https://github.com/acme/apps.git" || status.FailedStep != "repo_credentials" {
			t.Fatalf("unexpected GitopsStatus: %#v", status)
		}
		if strings.Contains(status.Error, "secret-token") {
			t.Fatalf("GitopsStatus leaked token in error: %q", status.Error)
		}

		direct := readGitopsSnapshot(false, "", io.Discard, io.Discard)
		if direct == nil || direct.Mode != "direct" {
			t.Fatalf("readGitopsSnapshot direct = %#v", direct)
		}
	})

	t.Run("timeouts parse positive durations and fall back on invalid values", func(t *testing.T) {
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "42s")
		if clusterReadyTimeout() != 42*time.Second {
			t.Fatalf("clusterReadyTimeout = %s, want 42s", clusterReadyTimeout())
		}
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "-1s")
		if clusterReadyTimeout() != 15*time.Minute {
			t.Fatalf("clusterReadyTimeout invalid fallback = %s", clusterReadyTimeout())
		}

		t.Setenv("ALETHIA_ADDON_CONVERGE_TIMEOUT", "0")
		if addonConvergeTimeout() != 0 {
			t.Fatalf("addonConvergeTimeout = %s, want 0", addonConvergeTimeout())
		}
		t.Setenv("ALETHIA_ADDON_CONVERGE_TIMEOUT", "bad")
		if addonConvergeTimeout() != 10*time.Minute {
			t.Fatalf("addonConvergeTimeout invalid fallback = %s", addonConvergeTimeout())
		}
	})

	t.Run("node readiness env opt out values", func(t *testing.T) {
		for _, value := range []string{"0", "false", "no", "off"} {
			t.Setenv("ALETHIA_CLUSTER_READY_REQUIRE_NODE", value)
			if clusterReadyRequireNode() {
				t.Fatalf("clusterReadyRequireNode(%q) = true, want false", value)
			}
		}
		t.Setenv("ALETHIA_CLUSTER_READY_REQUIRE_NODE", "yes")
		if !clusterReadyRequireNode() {
			t.Fatal("clusterReadyRequireNode should default to true")
		}
	})

	t.Run("short hash handles short and long hashes", func(t *testing.T) {
		if shortHash("abc") != "abc" {
			t.Fatalf("shortHash short = %q", shortHash("abc"))
		}
		if got := shortHash("1234567890abcdef"); got != "1234567890ab…" {
			t.Fatalf("shortHash long = %q", got)
		}
	})
}

func TestResolveArgoTemplatesDirUsesEnvBeforeFallbacks(t *testing.T) {
	t.Chdir(t.TempDir())
	envDir := filepath.Join(t.TempDir(), "templates")
	if err := os.MkdirAll(envDir, 0755); err != nil {
		t.Fatalf("mkdir env templates: %v", err)
	}
	if err := os.MkdirAll("argocd-templates", 0755); err != nil {
		t.Fatalf("mkdir fallback templates: %v", err)
	}
	t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", envDir)

	if got := resolveArgoTemplatesDir(); got != envDir {
		t.Fatalf("resolveArgoTemplatesDir = %q, want %q", got, envDir)
	}
}

func TestApplyBootstrapManifests(t *testing.T) {
	resetDeploySeams(t)

	t.Run("no output is a no-op", func(t *testing.T) {
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			t.Fatal("executeCommand called for empty bootstrap output")
			return nil
		}
		if err := applyBootstrapManifests(context.Background(), nil, io.Discard, io.Discard); err != nil {
			t.Fatalf("applyBootstrapManifests: %v", err)
		}
	})

	t.Run("writes manifests and applies server side", func(t *testing.T) {
		wantManifest := "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: cni\n"
		var gotCommand string
		executeCommand = func(command, dir string, _ []string, _, _ io.Writer) error {
			gotCommand = command
			if dir != "." {
				t.Fatalf("dir = %q, want .", dir)
			}
			path := strings.TrimSpace(strings.TrimPrefix(command[strings.LastIndex(command, "-f "):], "-f "))
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read manifest %q: %v", path, err)
			}
			if string(data) != wantManifest {
				t.Fatalf("manifest = %q, want %q", data, wantManifest)
			}
			return nil
		}
		if err := applyBootstrapManifests(context.Background(), map[string]interface{}{"bootstrap_manifests": wantManifest}, io.Discard, io.Discard); err != nil {
			t.Fatalf("applyBootstrapManifests: %v", err)
		}
		if !strings.Contains(gotCommand, "kubectl apply --server-side --force-conflicts -f ") {
			t.Fatalf("command = %q", gotCommand)
		}
	})

	t.Run("canceled context stops retries without waiting", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			return errors.New("api not ready")
		}
		err := applyBootstrapManifests(ctx, map[string]interface{}{"bootstrap_manifests": "kind: Namespace\n"}, io.Discard, io.Discard)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("applyBootstrapManifests error = %v, want context.Canceled", err)
		}
	})
}

func TestEnsureArgoRedisSecret(t *testing.T) {
	resetDeploySeams(t)

	t.Run("existing secret is not overwritten", func(t *testing.T) {
		var commands []string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, command)
			return nil
		}
		executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
			if !strings.Contains(command, "argocd-redis") {
				t.Fatalf("unexpected output command: %q", command)
			}
			return "already-set", nil
		}
		if err := ensureArgoRedisSecret(io.Discard, io.Discard); err != nil {
			t.Fatalf("ensureArgoRedisSecret: %v", err)
		}
		if len(commands) != 1 || !strings.Contains(commands[0], "kubectl create namespace argocd") {
			t.Fatalf("commands = %#v, want namespace create only", commands)
		}
	})

	t.Run("missing secret applies helm-adoptable manifest", func(t *testing.T) {
		var appliedManifest string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			if strings.HasPrefix(command, "kubectl apply -f ") {
				path := strings.TrimPrefix(command, "kubectl apply -f ")
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("read manifest: %v", err)
				}
				appliedManifest = string(data)
			}
			return nil
		}
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "", errors.New("not found")
		}
		var stdout bytes.Buffer
		if err := ensureArgoRedisSecret(&stdout, io.Discard); err != nil {
			t.Fatalf("ensureArgoRedisSecret: %v", err)
		}
		for _, want := range []string{
			"name: argocd-redis",
			"namespace: argocd",
			"app.kubernetes.io/managed-by: Helm",
			"meta.helm.sh/release-name: argo-cd",
			"auth:",
		} {
			if !strings.Contains(appliedManifest, want) {
				t.Fatalf("manifest missing %q:\n%s", want, appliedManifest)
			}
		}
		if !strings.Contains(stdout.String(), "Pre-seeded argocd-redis secret") {
			t.Fatalf("stdout = %q", stdout.String())
		}
	})
}

func TestInstallArgoCDBuildsIngressCommandOnlyWhenCertificateExists(t *testing.T) {
	resetDeploySeams(t)

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}

	var commands []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		commands = append(commands, command)
		return nil
	}

	result := &PlanResult{}
	vc := &types.ProjectConfig{
		DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"},
	}
	err := installArgoCD(
		context.Background(),
		vc,
		map[string]interface{}{"acm_certificate_arn": "arn:aws:acm:region:acct:certificate/123"},
		result,
		io.Discard,
		io.Discard,
	)
	if err != nil {
		t.Fatalf("installArgoCD: %v", err)
	}
	if result.ArgocdURL != "https://argocd.example.com" {
		t.Fatalf("ArgocdURL = %q", result.ArgocdURL)
	}
	if len(commands) < 3 {
		t.Fatalf("commands = %#v, want helm repo, namespace, install", commands)
	}
	install := commands[len(commands)-1]
	for _, want := range []string{
		"helm upgrade --install argo-cd",
		"server.ingress.enabled=true",
		"server.ingress.hostname=argocd.example.com",
		"arn:aws:acm:region:acct:certificate/123",
	} {
		if !strings.Contains(install, want) {
			t.Fatalf("install command missing %q:\n%s", want, install)
		}
	}

	result = &PlanResult{}
	commands = nil
	if err := installArgoCD(context.Background(), vc, nil, result, io.Discard, io.Discard); err != nil {
		t.Fatalf("installArgoCD without cert: %v", err)
	}
	if result.ArgocdURL != "" {
		t.Fatalf("ArgocdURL without cert = %q, want empty", result.ArgocdURL)
	}
	if strings.Contains(commands[len(commands)-1], "server.ingress.enabled=true") {
		t.Fatalf("install command enabled ingress without certificate:\n%s", commands[len(commands)-1])
	}
}

func TestAttachReceiptNoopsWithoutReport(t *testing.T) {
	result := &PlanResult{}
	attachReceipt(result, "missing-plan", nil, &verify.Override{Controls: []string{"x"}}, io.Discard)
	if result.VerifyReceipt != nil {
		t.Fatalf("VerifyReceipt = %#v, want nil without report", result.VerifyReceipt)
	}

	status := readGitopsSnapshot(false, "", io.Discard, io.Discard)
	if status.ArgocdApp != "" && status.ArgocdApp != argocd.UserAppsApplicationName {
		t.Fatalf("unexpected direct ArgocdApp: %q", status.ArgocdApp)
	}
}

// TestGitTokenValues asserts the collector gathers the apps-repo token plus every non-empty
// per-repo BYO token (and drops empties) so all of them can be redacted from error output (#948).
func TestGitTokenValues(t *testing.T) {
	got := gitTokenValues("apps-tok", map[string]string{
		"https://github.com/a/b":  "byo-1",
		"https://gitlab.com/c/d":  "byo-2",
		"https://example.com/e/f": "", // no token for this repo — must be skipped
	})
	want := map[string]bool{"apps-tok": true, "byo-1": true, "byo-2": true}
	if len(got) != len(want) {
		t.Fatalf("gitTokenValues = %#v, want the 3 non-empty tokens", got)
	}
	for _, tok := range got {
		if !want[tok] {
			t.Errorf("unexpected token %q", tok)
		}
	}

	// Empty apps token is dropped too; no tokens → empty (not nil-panic).
	if got := gitTokenValues("", nil); len(got) != 0 {
		t.Errorf("gitTokenValues empty = %#v, want none", got)
	}
}

// TestGitopsFailureRedactsAllTokens asserts a BYO per-repo token embedded in a wiring error is
// scrubbed from the persisted GitopsStatus.Error, not just the apps-repo token (#948).
func TestGitopsFailureRedactsAllTokens(t *testing.T) {
	byoTok := "glpat-byosecret"
	err := errors.New("clone https://x-access-token:" + byoTok + "@gitlab.com/acme/chart failed")
	gs := gitopsFailure(true, "https://github.com/acme/apps", "byo_charts", err,
		gitTokenValues("apps-tok", map[string]string{"https://gitlab.com/acme/chart": byoTok})...)
	if strings.Contains(gs.Error, byoTok) {
		t.Fatalf("BYO token survived in GitopsStatus.Error: %q", gs.Error)
	}
	if !strings.Contains(gs.Error, "[REDACTED]") {
		t.Errorf("want [REDACTED] marker, got %q", gs.Error)
	}
}
