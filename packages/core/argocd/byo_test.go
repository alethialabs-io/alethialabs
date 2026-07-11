// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"

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
		[]string{"payments", "payments", ""})
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
