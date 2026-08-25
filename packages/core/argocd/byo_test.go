// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestByoProjectName covers slug sanitization: lowercasing, non-alnum collapse, trimming, the
// empty fallback, and the 63-char RFC1123 cap.
func TestByoProjectName(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"payments", "byo-payments"},
		{"My Project!", "byo-my-project"},
		{"  spaced  ", "byo-spaced"},
		{"UPPER_snake.Case", "byo-upper-snake-case"},
		{"", "byo-project"},
		{"---", "byo-project"},
		{strings.Repeat("a", 80), "byo-" + strings.Repeat("a", 59)}, // capped at 63
	}
	for _, tt := range tests {
		got := ByoProjectName(tt.in)
		if got != tt.want {
			t.Errorf("ByoProjectName(%q) = %q, want %q", tt.in, got, tt.want)
		}
		if len(got) > 63 {
			t.Errorf("ByoProjectName(%q) length %d exceeds 63", tt.in, len(got))
		}
	}
}

// TestByoRepoSecretName is deterministic + per-repo distinct + prefixed.
func TestByoRepoSecretName(t *testing.T) {
	a := ByoRepoSecretName("https://github.com/acme/payments-helm")
	b := ByoRepoSecretName("https://github.com/acme/payments-helm")
	c := ByoRepoSecretName("https://github.com/acme/other")
	if a != b {
		t.Errorf("not deterministic: %q vs %q", a, b)
	}
	if a == c {
		t.Errorf("distinct repos collided: %q", a)
	}
	if !strings.HasPrefix(a, "repo-byo-") {
		t.Errorf("missing prefix: %q", a)
	}
}

// TestRenderByoAppProject asserts the hardened defaults: repos + namespaces locked, cluster-scoped
// resources default-denied (empty whitelist), RBAC/ServiceAccount namespace-blacklisted, and blank
// inputs deduped/dropped.
func TestRenderByoAppProject(t *testing.T) {
	out, err := RenderByoAppProject("byo-payments",
		[]string{"https://github.com/acme/payments-helm", "", "https://github.com/acme/payments-helm"},
		[]string{"payments", "payments", ""}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"name: byo-payments",
		"kind: AppProject",
		`- "https://github.com/acme/payments-helm"`,
		`namespace: "payments"`,
		"clusterResourceWhitelist: []",
		"namespaceResourceBlacklist:",
		"kind: RoleBinding",
		"kind: ServiceAccount",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered AppProject missing %q:\n%s", want, out)
		}
	}
	// Dedupe: the repo appears exactly once, the namespace exactly once.
	if n := strings.Count(out, "payments-helm"); n != 1 {
		t.Errorf("expected repo once (deduped), got %d:\n%s", n, out)
	}
	if n := strings.Count(out, `namespace: "payments"`); n != 1 {
		t.Errorf("expected namespace once (deduped), got %d:\n%s", n, out)
	}
	// A wide-open whitelist must never appear.
	if strings.Contains(out, `kind: "*"`) {
		t.Errorf("BYO AppProject must not whitelist all cluster resources:\n%s", out)
	}
}

// TestRenderAddOnApplication_GitSource covers a BYO chart: git path source (not chart), pinned to
// its byo project, and MANUAL sync (no automated/prune/self-heal block).
func TestRenderAddOnApplication_GitSource(t *testing.T) {
	out, err := RenderAddOnApplication(types.AddOnInstall{
		ID:        "payments",
		Mode:      "managed",
		Source:    "git",
		Project:   "byo-payments",
		ChartRepo: "https://github.com/acme/payments-helm",
		Path:      "charts/payments",
		Version:   "main",
		Namespace: "payments",
		Values:    map[string]interface{}{"replicas": 2},
		SyncWave:  5,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"project: byo-payments",
		"path: charts/payments",
		`targetRevision: "main"`,
		"alethia.io/addon-source: git",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("git-source Application missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "chart: ") {
		t.Errorf("git-source Application must not set a Helm `chart:`:\n%s", out)
	}
	if strings.Contains(out, "automated:") || strings.Contains(out, "selfHeal:") {
		t.Errorf("BYO Application must be manual-sync (no automated/self-heal):\n%s", out)
	}
}

// TestRenderAddOnApplication_HelmDefault is the regression guard: a marketplace add-on
// (Source unset) still renders the Helm `chart:` source, the "infra" project, and automated sync.
func TestRenderAddOnApplication_HelmDefault(t *testing.T) {
	out, err := RenderAddOnApplication(types.AddOnInstall{
		ID:        "kube-prometheus-stack",
		ChartRepo: "https://prometheus-community.github.io/helm-charts",
		Chart:     "kube-prometheus-stack",
		Version:   "57.0.0",
		Namespace: "monitoring",
		Values:    map[string]interface{}{},
		SyncWave:  1,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"project: infra",
		"chart: kube-prometheus-stack",
		"automated:",
		"selfHeal: true",
		"alethia.io/addon-source: helm",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("marketplace Application missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "path: ") {
		t.Errorf("Helm-source Application must not set a git `path:`:\n%s", out)
	}
}

// TestRenderByoNamespaces_RendersOneNamespacePerDestination pins the fix for the BYO-IaC sync
// failure found on gcp's first real run: the chart's Application carries CreateNamespace=true, but
// the hardened AppProject forbids cluster-scoped resources, so ArgoCD could never create it and
// every BYO sync died with `namespaces "<ns>" not found`.
func TestRenderByoNamespaces_RendersOneNamespacePerDestination(t *testing.T) {
	out, err := RenderByoNamespaces([]string{"byo-e2e", "payments"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"kind: Namespace", "name: byo-e2e", "name: payments", "\n---\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered namespaces missing %q:\n%s", want, out)
		}
	}
	if got := strings.Count(out, "kind: Namespace"); got != 2 {
		t.Errorf("want 2 Namespace documents, got %d:\n%s", got, out)
	}
}

// TestRenderByoNamespaces_DedupesAndDropsBlanks — two charts sharing a namespace must not render it
// twice (a duplicate document makes the multi-doc apply non-idempotent), and a blank namespace must
// not render a nameless Namespace, which the API server would reject and take the whole apply with it.
func TestRenderByoNamespaces_DedupesAndDropsBlanks(t *testing.T) {
	out, err := RenderByoNamespaces([]string{"shared", "", "shared", "other"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := strings.Count(out, "kind: Namespace"); got != 2 {
		t.Errorf("want 2 deduped Namespace documents, got %d:\n%s", got, out)
	}
	if strings.Contains(out, "name: \n") || strings.Contains(out, "name:\n") {
		t.Errorf("a blank namespace rendered a nameless Namespace:\n%s", out)
	}
}

// TestRenderByoNamespaces_EmptyIsEmptyNotAnError — no BYO charts must yield nothing to apply, and
// specifically NOT an error: a project with no git-source add-ons is the common case, and an error
// there would print a warning on every ordinary deploy.
func TestRenderByoNamespaces_EmptyIsEmptyNotAnError(t *testing.T) {
	for _, in := range [][]string{nil, {}, {""}, {"", ""}} {
		out, err := RenderByoNamespaces(in, nil)
		if err != nil {
			t.Errorf("RenderByoNamespaces(%q) errored: %v", in, err)
		}
		if out != "" {
			t.Errorf("RenderByoNamespaces(%q) = %q, want empty", in, out)
		}
	}
}

// TestRenderByoNamespaces_CarriesCommonLabels — the sweep/classification labels (BYOC B1.4) must
// land on the namespace too. A namespace the runner created but the sweeper cannot recognise is an
// orphan by construction, which is the leak shape this repo has already paid for twice.
func TestRenderByoNamespaces_CarriesCommonLabels(t *testing.T) {
	out, err := RenderByoNamespaces([]string{"byo-e2e"}, map[string]string{"alethia.io/project-id": "p-123"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "alethia.io/project-id: p-123") {
		t.Errorf("common labels not injected into the namespace:\n%s", out)
	}
	if !strings.Contains(out, "alethia.io/managed-by: byo-charts") {
		t.Errorf("namespace lost its managed-by label:\n%s", out)
	}
}

// TestByoAppProjectStillForbidsClusterResources is the OTHER direction, and the one that matters
// most. The bug is fixable two ways: create the namespace as the trusted runner (what we did), or
// let the untrusted chart create it by whitelisting Namespace on the AppProject (what we must never
// do). This test fails if anyone ever takes the second route, so the fix cannot be "corrected" into
// a hole in the trust boundary later.
func TestByoAppProjectStillForbidsClusterResources(t *testing.T) {
	out, err := RenderByoAppProject("byo-p", []string{"https://example.com/r"}, []string{"byo-e2e"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "clusterResourceWhitelist: []") {
		t.Errorf("the hardened BYO AppProject must keep an EMPTY clusterResourceWhitelist — the "+
			"namespace is created by the runner, never by the chart:\n%s", out)
	}
	if strings.Contains(out, "kind: Namespace") {
		t.Errorf("the AppProject must not whitelist Namespace:\n%s", out)
	}
}

// TestRenderByoNamespaces_RefusesYamlInjection is #2540: the namespace reached the renderer
// unvalidated (`z.string().trim().optional()`, no DNS-1123 check, a plain `text()` column, so
// interior newlines survive), was interpolated RAW into hand-rolled YAML, and the result was applied
// as a standalone MULTI-DOCUMENT manifest with the cluster's admin kubeconfig.
//
// So an injected `---` produced arbitrary top-level objects created by the runner — the exact
// cluster-scoped power the hardened AppProject exists to deny an untrusted chart. The fix that
// created the namespace in order to honour that boundary had opened a way around it.
//
// This is the payload from the issue, not a sanitised stand-in.
func TestRenderByoNamespaces_RefusesYamlInjection(t *testing.T) {
	payload := "byo-e2e\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: pwn"

	out, err := RenderByoNamespaces([]string{payload}, nil)
	if err == nil {
		t.Fatalf("an injected document was ACCEPTED — rendered:\n%s", out)
	}
	if out != "" {
		t.Errorf("a refused render must return no manifest at all, got:\n%s", out)
	}

	// The full payload is caught by the LENGTH rule, which is luck rather than defence — so the
	// case that matters is a SHORT one, where length cannot save us and only the charset rule can.
	// 30 characters, still a complete second document.
	short := "a\n---\nkind: ClusterRoleBinding"
	if len(short) > dns1123LabelMaxLen {
		t.Fatalf("the short payload must be under the length limit or it proves nothing (%d chars)", len(short))
	}
	out, err = RenderByoNamespaces([]string{short}, nil)
	if err == nil {
		t.Fatalf("a SHORT injected document was ACCEPTED — rendered:\n%s", out)
	}
	if !strings.Contains(err.Error(), "DNS-1123") {
		t.Errorf("the short payload must be refused by the DNS-1123 rule, not incidentally; got: %v", err)
	}

	// And the structural half: even with validation removed, marshalling alone must make a hostile
	// value one absurd NAME rather than a second document. Encode the payload directly to prove the
	// encoder quotes it.
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	if err := enc.Encode(map[string]any{"name": short}); err != nil {
		t.Fatalf("encode: %v", err)
	}
	_ = enc.Close()
	if strings.Contains(buf.String(), "\n---\n") {
		t.Errorf("the encoder emitted a document separator from a VALUE — marshalling is not containing it:\n%s", buf.String())
	}
}

// TestRenderByoNamespaces_RefusesNamesKubernetesWould is the general case behind the injection one.
// Refusing rather than normalising is deliberate: the SAME string is written into the hardened
// AppProject's `destinations`, so silently rewriting it here would produce a project whose
// destination never matches the namespace the chart syncs into — an ArgoCD permission error naming
// neither cause.
func TestRenderByoNamespaces_RefusesNamesKubernetesWould(t *testing.T) {
	for _, bad := range []string{
		"Byo-E2E",               // uppercase
		"byo_e2e",               // underscore
		"-byo",                  // leading dash
		"byo-",                  // trailing dash
		"byo e2e",               // space
		"byo/e2e",               // slash
		`byo"e2e`,               // a quote — would break OUT of the AppProject's quoted form
		strings.Repeat("a", 64), // one over the DNS-1123 label limit
	} {
		if _, err := RenderByoNamespaces([]string{bad}, nil); err == nil {
			t.Errorf("namespace %q was accepted; Kubernetes would refuse it", bad)
		}
	}
	// …and the boundary case on the other side of the length rule is still fine.
	if _, err := RenderByoNamespaces([]string{strings.Repeat("a", 63)}, nil); err != nil {
		t.Errorf("a 63-character label is legal and must be accepted: %v", err)
	}
}

// TestRenderByoNamespaces_IsDeterministic — the render is committed to nothing, but it IS applied on
// every deploy, and a manifest that differs between identical deploys makes `kubectl apply` churn
// and any diff meaningless. Go randomises map iteration; this pins that the encoder does not.
func TestRenderByoNamespaces_IsDeterministic(t *testing.T) {
	labels := map[string]string{"z": "1", "a": "2", "m": "3", "alethia.io/project-id": "p-123"}
	first, err := RenderByoNamespaces([]string{"byo-e2e", "payments"}, labels)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for i := 0; i < 25; i++ {
		got, err := RenderByoNamespaces([]string{"byo-e2e", "payments"}, labels)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != first {
			t.Fatalf("render is not deterministic (iteration %d):\nfirst:\n%s\ngot:\n%s", i, first, got)
		}
	}
}
