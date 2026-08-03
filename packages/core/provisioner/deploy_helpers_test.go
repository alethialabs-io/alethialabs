// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

func resetDeploySeams(t *testing.T) {
	t.Helper()
	origExecuteCommand := executeCommand
	origExecuteCommandWithOutput := executeCommandWithOutput
	origNamespacePostMortem := namespacePostMortem
	t.Cleanup(func() {
		executeCommand = origExecuteCommand
		executeCommandWithOutput = origExecuteCommandWithOutput
		namespacePostMortem = origNamespacePostMortem
	})
}

func TestDeployHelperPolicyFunctions(t *testing.T) {
	t.Run("enabled add-on ids preserve desired order", func(t *testing.T) {
		got := enabledAddonIDs([]types.AddOnInstall{{ID: "db"}, {ID: "cache"}, {ID: "queue"}})
		if strings.Join(got, ",") != "db,cache,queue" {
			t.Fatalf("enabledAddonIDs = %#v", got)
		}
	})

	t.Run("compat add-on refs carry id + pinned version, nil for empty", func(t *testing.T) {
		if got := compatAddOnRefs(nil); got != nil {
			t.Fatalf("compatAddOnRefs(nil) = %#v, want nil (no add-ons → empty subject slice)", got)
		}
		got := compatAddOnRefs([]types.AddOnInstall{
			{ID: "kube-prometheus-stack", Version: "58.1.0"},
			{ID: "cnpg"}, // version may be empty (git-ref add-ons); the ref must still carry the id
		})
		if len(got) != 2 {
			t.Fatalf("compatAddOnRefs len = %d, want 2", len(got))
		}
		if got[0].ID != "kube-prometheus-stack" || got[0].Version != "58.1.0" {
			t.Errorf("ref[0] = %#v", got[0])
		}
		if got[1].ID != "cnpg" || got[1].Version != "" {
			t.Errorf("ref[1] = %#v", got[1])
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

		direct := gitopsFailure(false, "", argocd.GitopsStepArgocdInstall, errors.New("helm timeout"))
		if direct.Mode != "direct" || direct.AppsRepo != "" ||
			direct.FailedStep != argocd.GitopsStepArgocdInstall || direct.Error != "helm timeout" {
			t.Fatalf("unexpected direct GitopsStatus: %#v", direct)
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
		"--set redisSecretInit.enabled=false",
		// Derived from the resolver, not a literal, so the assertion cannot drift from the source
		// when the default budget is retuned. The env-override case is covered separately below.
		"--wait --timeout " + utils.ShellQuote(argocd.ResolvedArgoInstallTimeout()),
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

// TestInstallArgoCDHonoursTimeoutOverride pins that the env knob actually reaches the helm command.
// The assertion above derives its expectation from the same resolver, so it would pass even if the
// timeout were never interpolated — this is the case that proves the wiring.
func TestInstallArgoCDHonoursTimeoutOverride(t *testing.T) {
	resetDeploySeams(t)
	t.Setenv(argocd.ArgoInstallTimeoutEnv, "23m")

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	var commands []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		commands = append(commands, command)
		return nil
	}

	err := installArgoCD(context.Background(), &types.ProjectConfig{}, nil, &PlanResult{}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("installArgoCD: %v", err)
	}
	install := commands[len(commands)-1]
	if !strings.Contains(install, "--wait --timeout '23m'") {
		t.Fatalf("install command did not carry the overridden timeout:\n%s", install)
	}
}

// TestInstallArgoCDDumpsPostMortemOnHelmFailure pins the #1734 contract: when the helm install
// fails, the namespace's state is dumped to STDOUT before the error propagates — and the install
// still FAILS CLOSED (#1718). Three nights of the aws nightly died here with nothing to act on
// because helm's "context deadline exceeded" names neither the pod nor the reason.
func TestInstallArgoCDDumpsPostMortemOnHelmFailure(t *testing.T) {
	resetDeploySeams(t)

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		if strings.Contains(command, "helm upgrade --install argo-cd") {
			return errors.New("exit status 1")
		}
		return nil
	}
	var dumped []string
	namespacePostMortem = func(ns string) string {
		dumped = append(dumped, ns)
		return "POST-MORTEM BODY"
	}

	var stdout, stderr bytes.Buffer
	err := installArgoCD(context.Background(), &types.ProjectConfig{}, nil, &PlanResult{}, &stdout, &stderr)
	if err == nil {
		t.Fatal("installArgoCD returned nil — the install must still FAIL CLOSED (#1718)")
	}
	if len(dumped) != 1 || dumped[0] != "argocd" {
		t.Fatalf("post-mortem calls = %#v, want exactly one for the argocd namespace", dumped)
	}
	if !strings.Contains(stdout.String(), "POST-MORTEM BODY") {
		t.Fatalf("post-mortem did not reach stdout:\n%s", stdout.String())
	}
	if strings.Contains(stderr.String(), "POST-MORTEM BODY") {
		t.Fatal("post-mortem went to stderr; it must be on stdout so the runner log and console job log both carry it")
	}

	// The success path must not dump: a post-mortem on a healthy install is noise that trains
	// readers to ignore it.
	dumped = nil
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return nil }
	if err := installArgoCD(context.Background(), &types.ProjectConfig{}, nil, &PlanResult{}, io.Discard, io.Discard); err != nil {
		t.Fatalf("installArgoCD on the success path: %v", err)
	}
	if len(dumped) != 0 {
		t.Fatalf("post-mortem ran on the success path: %#v", dumped)
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

// TestInstallArgoCDAttachesWAFWebACLOnlyWhenPresent is the proof that the canvas WAF switch
// reaches something. The template has always BUILT a regional web ACL and associated it with
// nothing; the ALB ingress annotation is the attach. Two directions matter and they fail
// differently:
//
//   - the ARN present must reach `alb.ingress.kubernetes.io/wafv2-acl-arn` on the helm command
//     (otherwise the project pays for an ACL that inspects zero requests, silently);
//   - the ARN ABSENT must emit NO annotation key at all — an empty wafv2-acl-arn value is not
//     "no WAF", it is a malformed association the ALB controller refuses, which wedges the
//     whole ingress reconcile and takes ArgoCD's URL down with it.
func TestInstallArgoCDAttachesWAFWebACLOnlyWhenPresent(t *testing.T) {
	const wafArn = "arn:aws:wafv2:us-east-1:123456789012:regional/webacl/app-waf/0c4e-1"
	const certArn = "arn:aws:acm:us-east-1:123456789012:certificate/123"

	installCommandFor := func(t *testing.T, outputs map[string]interface{}) string {
		t.Helper()
		resetDeploySeams(t)
		executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
		var commands []string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, command)
			return nil
		}
		vc := &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"}}
		if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
			t.Fatalf("installArgoCD: %v", err)
		}
		if len(commands) == 0 {
			t.Fatal("no commands executed")
		}
		return commands[len(commands)-1]
	}

	t.Run("web ACL present is annotated onto the ingress", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{
			"acm_certificate_arn": certArn,
			"waf_webacl_arn":      wafArn,
		})
		for _, want := range []string{`alb\.ingress\.kubernetes\.io/wafv2-acl-arn=` + wafArn, "server.ingress.enabled=true"} {
			if !strings.Contains(install, want) {
				t.Fatalf("install command missing %q:\n%s", want, install)
			}
		}
	})

	t.Run("waf off emits no annotation key at all", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{"acm_certificate_arn": certArn})
		if strings.Contains(install, "wafv2-acl-arn") {
			t.Fatalf("install command carries a wafv2-acl-arn annotation with no web ACL:\n%s", install)
		}
		// The rest of the ingress must be untouched — this path is the common case.
		if !strings.Contains(install, "server.ingress.enabled=true") {
			t.Fatalf("install command lost the ingress:\n%s", install)
		}
	})

	// A null output (the shape tofu emits when application_waf_enabled is false) must behave
	// exactly like an absent one — ExtractOutput yields "", and "" must mean "no annotation".
	t.Run("a null waf output is not an empty annotation", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{
			"acm_certificate_arn": certArn,
			"waf_webacl_arn":      nil,
		})
		if strings.Contains(install, "wafv2-acl-arn") {
			t.Fatalf("a null waf_webacl_arn produced an annotation:\n%s", install)
		}
	})

	// No certificate ⇒ no ingress at all ⇒ nothing to annotate, even with a web ACL built.
	t.Run("no ingress means no annotation even with a web ACL", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{"waf_webacl_arn": wafArn})
		if strings.Contains(install, "wafv2-acl-arn") || strings.Contains(install, "server.ingress.enabled=true") {
			t.Fatalf("annotated an ingress that was never configured:\n%s", install)
		}
	})
}

// TestArgocdURLAndWAFDecisionsMatchWhatInstallArgoCDEmits is the anti-drift assertion between
// the two halves of the same claim: installArgoCD DECIDES what to emit, and
// argocd.InfraServiceDecisions REPORTS what was emitted, from separate packages that had no
// test forcing them to agree.
//
// They disagreed. installArgoCD renders the ingress inside `if vc.DNS.Enabled &&
// vc.DNS.DomainName != ""` and only then when the ACM certificate output is present;
// argocdURLGates["aws"] checked the certificate ALONE. A project with DNS off, a domain, a zone
// id and the certificate switch on therefore got a real certificate ARN, NO ingress, and a
// console reporting "installed — ArgoCD is exposed over the ALB ingress" plus a WAF "attached"
// via an annotation that was never emitted. Reachable in practice: acm_certificate_enable comes
// from DNS.ManagedCertificate, which is independent of DNS.Enabled and settable straight through
// provider_config.
//
// Asserting equivalence over the whole matrix rather than spot-checking the one broken cell is
// the point — it is what makes the next ingress lane unable to reintroduce the same gap.
func TestArgocdURLAndWAFDecisionsMatchWhatInstallArgoCDEmits(t *testing.T) {
	const wafArn = "arn:aws:wafv2:us-east-1:123456789012:regional/webacl/app-waf/0c4e-1"
	const certArn = "arn:aws:acm:us-east-1:123456789012:certificate/123"

	decisionStatus := func(t *testing.T, f *argocd.InfraFacts, service string) string {
		t.Helper()
		for _, d := range argocd.InfraServiceDecisions(f) {
			if d.Service == service {
				return d.Status
			}
		}
		t.Fatalf("no %q decision was produced", service)
		return ""
	}

	for _, dnsEnabled := range []bool{true, false} {
		for _, domain := range []string{"example.com", ""} {
			for _, cert := range []string{certArn, ""} {
				for _, acl := range []string{wafArn, ""} {
					name := fmt.Sprintf("dns=%t domain=%q cert=%t acl=%t", dnsEnabled, domain, cert != "", acl != "")
					t.Run(name, func(t *testing.T) {
						resetDeploySeams(t)
						executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
						var commands []string
						executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
							commands = append(commands, command)
							return nil
						}
						vc := &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: dnsEnabled, DomainName: domain}}
						outputs := map[string]interface{}{}
						if cert != "" {
							outputs["acm_certificate_arn"] = cert
						}
						if acl != "" {
							outputs["waf_webacl_arn"] = acl
						}
						if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
							t.Fatalf("installArgoCD: %v", err)
						}
						if len(commands) == 0 {
							t.Fatal("no commands executed")
						}
						install := commands[len(commands)-1]

						// The facts the runner would build from the same deploy.
						f := &argocd.InfraFacts{
							Provider: "aws", DNSEnabled: dnsEnabled, DomainName: domain,
							ACMCertificateArn: cert, WAFWebACLArn: acl,
						}

						emittedIngress := strings.Contains(install, "server.ingress.enabled=true")
						reportedURL := decisionStatus(t, f, "argocd-url") == "installed"
						if emittedIngress != reportedURL {
							t.Errorf("argocd-url decision (%t) disagrees with the emitted ingress (%t)\n%s",
								reportedURL, emittedIngress, install)
						}

						emittedWAF := strings.Contains(install, "wafv2-acl-arn")
						reportedWAF := decisionStatus(t, f, "waf") == "installed"
						if emittedWAF != reportedWAF {
							t.Errorf("waf decision (%t) disagrees with the emitted annotation (%t)\n%s",
								reportedWAF, emittedWAF, install)
						}
					})
				}
			}
		}
	}
}

// TestGKEArgocdURLAndWAFDecisionsMatchWhatInstallArgoCDEmits is the same anti-drift assertion as
// the AWS one above, for the cloud whose gate just MOVED (#1858).
//
// It is a separate test rather than another dimension of that matrix because the two clouds are
// gated on different KINDS of thing and one loop would have to fake both: AWS's gate is a single
// tofu output, GCP's is a predicate over four facts (the certificate switch, DNS, the domain, and
// whether cert-manager has a solver that can complete a challenge here). Sweeping all four is the
// point — a gate that mirrors the emitter on the happy path and diverges on "the switch is on but
// the workload identity is missing" is precisely the AWS bug this invariant exists to prevent, and
// that combination is now REACHABLE on GCP: ManagedCertificate rides straight through
// provider_config, independent of every output.
//
// Both directions are asserted, and the WAF half comes free: wafAttachments["gcp"] reads the
// argocd-url decision, so a drifting ingress gate would silently drag the Cloud Armor claim with it.
func TestGKEArgocdURLAndWAFDecisionsMatchWhatInstallArgoCDEmits(t *testing.T) {
	const policy = "alethia-nl-production-armor-policy"

	decisionStatus := func(t *testing.T, f *argocd.InfraFacts, service string) string {
		t.Helper()
		for _, d := range argocd.InfraServiceDecisions(f) {
			if d.Service == service {
				return d.Status
			}
		}
		t.Fatalf("no %q decision was produced", service)
		return ""
	}

	// An equivalence assertion is satisfied by two sides that are both always false, and "no
	// combination ever rendered an ingress" is a plausible way for this to rot — so count the
	// positives and demand at least one of each below.
	var sawIngress, sawWAF int

	for _, dnsEnabled := range []bool{true, false} {
		for _, domain := range []string{"example.com", ""} {
			for _, managedCert := range []bool{true, false} {
				for _, solverFacts := range []bool{true, false} {
					for _, armor := range []string{policy, ""} {
						name := fmt.Sprintf("dns=%t domain=%q cert=%t solver=%t armor=%t",
							dnsEnabled, domain, managedCert, solverFacts, armor != "")
						t.Run(name, func(t *testing.T) {
							resetDeploySeams(t)
							executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
							var commands []string
							executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
								commands = append(commands, command)
								return nil
							}

							outputs := map[string]interface{}{}
							if solverFacts {
								outputs = gkeCertManagerOutputs(nil)
							}
							if armor != "" {
								outputs["cloud_armor_policy_name"] = armor
							}
							vc := &types.ProjectConfig{
								Provider: "gcp",
								DNS: types.ProjectDNSConfig{
									Enabled: dnsEnabled, DomainName: domain, ManagedCertificate: managedCert,
								},
							}
							if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
								t.Fatalf("installArgoCD: %v", err)
							}
							if len(commands) == 0 {
								t.Fatal("no commands executed")
							}
							install := commands[len(commands)-1]

							// The facts the runner would build from the same deploy — written out
							// rather than re-read from BuildFromOutputs, so the two sides of the
							// comparison stay independent.
							f := &argocd.InfraFacts{
								Provider: "gcp", DNSEnabled: dnsEnabled, DomainName: domain,
								ManagedCertificate: managedCert, GCPArmorPolicy: armor,
							}
							if solverFacts {
								f.GCPExternalDNSSA = "external-dns@alethia-nl.iam.gserviceaccount.com"
								f.GCPProjectID = "alethia-nl"
								f.GCPDNSZoneName = "alethia-nl-production-dns"
							}

							// GKE's ingress is a values FILE, so "-f" on the helm command IS the
							// emission — there is no `--set server.ingress.enabled=true` to grep.
							emittedIngress := strings.Contains(install, " -f ")
							if emittedIngress {
								sawIngress++
							}
							reportedURL := decisionStatus(t, f, "argocd-url") == "installed"
							if emittedIngress != reportedURL {
								t.Errorf("argocd-url decision (%t) disagrees with the emitted ingress (%t)\n%s",
									reportedURL, emittedIngress, install)
							}

							// The Cloud Armor attach is the BackendConfig applied BEFORE helm, not
							// an annotation on the install command — so it is looked for across
							// every command rather than in the last one.
							emittedWAF := false
							for _, c := range commands {
								if strings.Contains(c, "backendconfig.yaml") {
									emittedWAF = true
								}
							}
							if emittedWAF {
								sawWAF++
							}
							reportedWAF := decisionStatus(t, f, "waf") == "installed"
							if emittedWAF != reportedWAF {
								t.Errorf("waf decision (%t) disagrees with the applied BackendConfig (%t)\n%v",
									reportedWAF, emittedWAF, commands)
							}
						})
					}
				}
			}
		}
	}

	if sawIngress == 0 {
		t.Error("no combination rendered a GKE ingress — the equivalence above is vacuously true")
	}
	if sawWAF == 0 {
		t.Error("no combination applied a BackendConfig — the WAF equivalence above is vacuously true")
	}
}

// gkeCertManagerOutputs is the tofu-output shape a GCP deploy has when cert-manager can actually
// issue: the external-dns workload identity cert-manager's clouddns solver reuses, the project id,
// and the zone NAME the solver needs because that grant is zone-scoped. Together with
// DNS.ManagedCertificate on the config they are exactly InfraFacts.CertManagerEnabled(), which is
// the gate the GKE ingress moved onto in #1858.
func gkeCertManagerOutputs(extra map[string]interface{}) map[string]interface{} {
	outputs := map[string]interface{}{
		"external_dns_service_account": "external-dns@alethia-nl.iam.gserviceaccount.com",
		"gcp_project_id":               "alethia-nl",
		"cloud_dns_zone_name":          "alethia-nl-production-dns",
	}
	for k, v := range extra {
		outputs[k] = v
	}
	return outputs
}

// TestInstallArgoCDGKEIngress is the GCP half of "the canvas switch reaches something".
//
// GKE needs no ingress CONTROLLER — Google's runs in the managed control plane — so unlike AWS
// there is no Application to assert. What must be proven instead is that the ingress leaves the
// runner asking for the RIGHT certificate: since #1858 that is a cert-manager one
// (`cert-manager.io/cluster-issuer` + a `spec.tls` entry the ingress-shim turns into a Certificate),
// NOT the Google-managed certificate behind `ingress.gcp.kubernetes.io/pre-shared-cert`. The Cloud
// Armor half is unchanged and independent of how TLS is obtained: a policy onto a BackendConfig
// bound to the ArgoCD server Service.
//
// The values reach helm as a FILE rather than `--set` flags, because the backend-config
// annotation's value is the JSON document {"default":"argocd-server"} and helm's --set parser
// reads a leading `{` as a list literal. The file is read back here, inside the fake executor,
// while it still exists — asserting the flag alone would prove only that a path was interpolated.
func TestInstallArgoCDGKEIngress(t *testing.T) {
	const cert = "alethia-nl-production-platform-cert"
	const policy = "alethia-nl-production-armor-policy"

	// run drives installArgoCD with the given outputs and returns every command it issued plus the
	// contents of the values file the last helm command referenced (empty when it referenced none).
	run := func(t *testing.T, managedCert bool, outputs map[string]interface{}) (cmds []string, values string, url string) {
		t.Helper()
		resetDeploySeams(t)
		executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			cmds = append(cmds, command)
			// Read any -f'd values file NOW: installArgoCD removes its temp dir on return.
			if i := strings.Index(command, "helm upgrade --install argo-cd"); i == 0 {
				if j := strings.Index(command, " -f "); j >= 0 {
					path := strings.Trim(strings.TrimSpace(command[j+4:]), "'\"")
					b, err := os.ReadFile(path)
					if err != nil {
						t.Errorf("values file %s unreadable at helm time: %v", path, err)
					}
					values = string(b)
				}
			}
			return nil
		}
		result := &PlanResult{}
		vc := &types.ProjectConfig{
			Provider: "gcp",
			DNS: types.ProjectDNSConfig{
				Enabled: true, DomainName: "example.com", ManagedCertificate: managedCert,
			},
		}
		if err := installArgoCD(context.Background(), vc, outputs, result, io.Discard, io.Discard); err != nil {
			t.Fatalf("installArgoCD: %v", err)
		}
		return cmds, values, result.ArgocdURL
	}

	t.Run("certificate + policy: gce ingress, BackendConfig applied before helm", func(t *testing.T) {
		cmds, values, url := run(t, true, gkeCertManagerOutputs(map[string]interface{}{
			"cloud_dns_managed_certificate_name": cert,
			"cloud_armor_policy_name":            policy,
		}))
		if url != "https://argocd.example.com" {
			t.Errorf("ArgocdURL = %q", url)
		}
		for _, want := range []string{
			"ingressClassName: gce",
			"hostname: argocd.example.com",
			`cert-manager.io/cluster-issuer: "` + argocd.CertManagerIssuerName + `"`,
			"secretName: " + argocd.GKEArgoServerTLSSecret,
			// The window before cert-manager exists is fail-closed on this annotation alone.
			`kubernetes.io/ingress.allow-http: "false"`,
			`cloud.google.com/backend-config: '{"default":"` + argocd.GKEBackendConfigName + `"}'`,
		} {
			if !strings.Contains(values, want) {
				t.Errorf("helm values missing %q:\n%s", want, values)
			}
		}
		// The Google-managed certificate must not come along for the ride. The project still HAS
		// one (the output above is set) — the point of this lane is that the ingress stopped
		// attaching it, so two TLS mechanisms cannot both be live on one Ingress.
		if strings.Contains(values, "pre-shared-cert") {
			t.Errorf("the ingress still attaches the Google-managed certificate:\n%s", values)
		}
		// ORDER is the point, not merely presence: the BackendConfig must exist before the chart
		// creates the Service that names it, or the load balancer is programmed once with no
		// security policy on it — the exact window this lane closes.
		applyIdx, helmIdx := -1, -1
		for i, c := range cmds {
			if strings.HasPrefix(c, "kubectl apply -f") && strings.Contains(c, "backendconfig.yaml") {
				applyIdx = i
			}
			if strings.HasPrefix(c, "helm upgrade --install argo-cd") {
				helmIdx = i
			}
		}
		if applyIdx < 0 {
			t.Fatalf("no BackendConfig apply issued:\n%v", cmds)
		}
		if helmIdx < 0 || applyIdx > helmIdx {
			t.Errorf("BackendConfig applied at %d, helm install at %d — it must come first", applyIdx, helmIdx)
		}
	})

	t.Run("WAF off: ingress intact, no BackendConfig anywhere", func(t *testing.T) {
		cmds, values, url := run(t, true, gkeCertManagerOutputs(map[string]interface{}{
			"cloud_dns_managed_certificate_name": cert,
			// null is the shape tofu emits when cloud_armor_enabled is false; it must behave
			// exactly like an absent key.
			"cloud_armor_policy_name": nil,
		}))
		if url != "https://argocd.example.com" {
			t.Errorf("the ingress must still be configured with the WAF off, ArgocdURL = %q", url)
		}
		if !strings.Contains(values, "ingressClassName: gce") {
			t.Errorf("lost the ingress when the WAF switch was off:\n%s", values)
		}
		if strings.Contains(values, "backend-config") {
			t.Errorf("values name a BackendConfig with no Cloud Armor policy — GKE would stall on it:\n%s", values)
		}
		for _, c := range cmds {
			if strings.Contains(c, "backendconfig.yaml") {
				t.Errorf("applied a BackendConfig with no policy: %s", c)
			}
		}
	})

	// The certificate switch is off, so nothing issues. Note the Google-managed certificate name is
	// deliberately PRESENT in the outputs: before #1858 that alone rendered the ingress, and this
	// case is what stops that gate creeping back.
	t.Run("certificate switch off: no ingress, no URL, no BackendConfig", func(t *testing.T) {
		cmds, values, url := run(t, false, gkeCertManagerOutputs(map[string]interface{}{
			"cloud_dns_managed_certificate_name": cert,
			"cloud_armor_policy_name":            policy,
		}))
		if url != "" {
			t.Errorf("ArgocdURL = %q, want empty with no certificate issuer", url)
		}
		if values != "" {
			t.Errorf("rendered ingress values with nothing to issue its certificate:\n%s", values)
		}
		for _, c := range cmds {
			if strings.Contains(c, "backendconfig.yaml") {
				t.Errorf("applied a BackendConfig for an ingress that was never rendered: %s", c)
			}
		}
	})

	// The switch is ON and the solver's facts are MISSING — the shape that used to be invisible.
	// cert-manager cannot write a challenge record without the external-dns identity and the
	// zone-scoped grant's zone NAME, so nothing would ever populate the TLS secret; rendering the
	// Ingress anyway would publish a load balancer that serves nothing, forever, while the console
	// reported an ArgoCD URL. A Cloud Armor policy must not drag it into existence either.
	t.Run("issuer unsatisfiable: no ingress even with the switch on and a policy built", func(t *testing.T) {
		cmds, values, url := run(t, true, map[string]interface{}{
			"cloud_dns_managed_certificate_name": cert,
			"cloud_armor_policy_name":            policy,
		})
		if url != "" || values != "" {
			t.Errorf("rendered an ingress cert-manager could never issue for (url=%q):\n%s", url, values)
		}
		for _, c := range cmds {
			if strings.Contains(c, "backendconfig.yaml") {
				t.Errorf("applied a BackendConfig for an ingress that was never rendered: %s", c)
			}
		}
	})

	// The AWS path must be completely unaffected by the new branch: its gate is still its own ACM
	// output, and a deploy carrying one must still get the ALB `--set` chain — even though these
	// facts would also satisfy cert-manager, since the arms are ordered and mutually exclusive.
	t.Run("aws is untouched by the gcp branch", func(t *testing.T) {
		cmds, values, _ := run(t, true, map[string]interface{}{
			"acm_certificate_arn": "arn:aws:acm:us-east-1:111111111111:certificate/abc",
		})
		if values != "" {
			t.Errorf("aws must not use a values file:\n%s", values)
		}
		install := cmds[len(cmds)-1]
		if !strings.Contains(install, "server.ingress.ingressClassName=alb") {
			t.Errorf("aws lost its ALB ingress:\n%s", install)
		}
	})
}
