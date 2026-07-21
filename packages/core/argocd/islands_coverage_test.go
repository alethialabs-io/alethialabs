// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestDNSProvider_FullMatrix pins the external-dns `provider` value the InfraFacts render
// against for every (cloud, DNS-connector, credential-present) combination. The empty return
// is load-bearing: it is the render gate's signal to SKIP external-dns entirely rather than
// ship a controller with a malformed identity annotation that crash-loops. These paths are
// constructed directly on InfraFacts (not via BuildFromOutputs) so each branch is exercised
// in isolation.
func TestDNSProvider_FullMatrix(t *testing.T) {
	cases := []struct {
		name string
		f    InfraFacts
		want string
	}{
		{
			name: "cloudflare connector with credential renders cloudflare",
			f:    InfraFacts{Provider: "aws", DNSConnector: "cloudflare", DNSCredentialPresent: true},
			want: "cloudflare",
		},
		{
			name: "cloudflare connector without credential fails closed",
			f:    InfraFacts{Provider: "aws", DNSConnector: "cloudflare", DNSCredentialPresent: false},
			want: "",
		},
		{
			name: "unknown non-native connector fails closed",
			f:    InfraFacts{Provider: "aws", DNSConnector: "route53-custom", DNSCredentialPresent: true},
			want: "",
		},
		{
			name: "aws native backend",
			f:    InfraFacts{Provider: "aws"},
			want: "aws",
		},
		{
			name: "aws with explicit native connector keeps the cloud backend",
			f:    InfraFacts{Provider: "aws", DNSConnector: "native"},
			want: "aws",
		},
		{
			name: "gcp with workload-identity GSA renders google",
			f:    InfraFacts{Provider: "gcp", GCPExternalDNSSA: "dns@proj.iam.gserviceaccount.com"},
			want: "google",
		},
		{
			name: "gcp without GSA fails closed",
			f:    InfraFacts{Provider: "gcp", GCPExternalDNSSA: ""},
			want: "",
		},
		{
			name: "azure with client id renders azure",
			f:    InfraFacts{Provider: "azure", AzureExternalDNSClient: "00000000-0000-0000-0000-000000000000"},
			want: "azure",
		},
		{
			name: "azure without client id fails closed",
			f:    InfraFacts{Provider: "azure", AzureExternalDNSClient: ""},
			want: "",
		},
		{
			name: "alibaba is an honest skip until RRSA lands upstream",
			f:    InfraFacts{Provider: "alibaba"},
			want: "",
		},
		{
			name: "hetzner with cloud token renders the webhook sidecar",
			f:    InfraFacts{Provider: "hetzner", DNSCredentialPresent: true},
			want: "webhook",
		},
		{
			name: "hetzner without cloud token fails closed",
			f:    InfraFacts{Provider: "hetzner", DNSCredentialPresent: false},
			want: "",
		},
		{
			name: "unknown/connect-only cloud fails closed",
			f:    InfraFacts{Provider: "digitalocean"},
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.f.DNSProvider(); got != c.want {
				t.Fatalf("DNSProvider() = %q, want %q", got, c.want)
			}
		})
	}
}

// TestExtractOutput_Variants covers every shape a tofu output can take in the decoded JSON:
// a bare string, the wrapped {"value": …} object tofu emits, a missing key, a nil value, and
// non-string payloads. A wrong extraction would silently feed an empty (or garbage) identity
// into the render, so each branch is asserted explicitly.
func TestExtractOutput_Variants(t *testing.T) {
	outputs := map[string]interface{}{
		"bare_string":  "eks-demo",
		"wrapped":      map[string]interface{}{"value": "vpc-123"},
		"wrapped_int":  map[string]interface{}{"value": 42},
		"wrapped_none": map[string]interface{}{"sensitive": true},
		"nil_value":    nil,
		"int_value":    7,
	}
	cases := []struct {
		key  string
		want string
	}{
		{"bare_string", "eks-demo"},
		{"wrapped", "vpc-123"},
		{"wrapped_int", ""},  // {"value": 42} — non-string value is not extracted
		{"wrapped_none", ""}, // object without a "value" key
		{"nil_value", ""},    // present but nil
		{"int_value", ""},    // scalar that is neither string nor map
		{"absent_key", ""},   // missing entirely
	}
	for _, c := range cases {
		if got := ExtractOutput(outputs, c.key); got != c.want {
			t.Errorf("ExtractOutput(%q) = %q, want %q", c.key, got, c.want)
		}
	}
}

// TestFirstNonEmpty covers the fallback helper BuildFromOutputs uses to prefer a tofu output
// over the config's account id — including the all-empty case that must return "".
func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "", "third"); got != "third" {
		t.Errorf("firstNonEmpty skipped empties wrong: got %q, want %q", got, "third")
	}
	if got := firstNonEmpty("first", "second"); got != "first" {
		t.Errorf("firstNonEmpty must return the first non-empty: got %q, want %q", got, "first")
	}
	if got := firstNonEmpty("", ""); got != "" {
		t.Errorf("firstNonEmpty of all-empty must be empty, got %q", got)
	}
	if got := firstNonEmpty(); got != "" {
		t.Errorf("firstNonEmpty of nothing must be empty, got %q", got)
	}
}

// TestK8sNameGuard_FailClosed verifies the RFC-1123 DNS-label guard that PruneChartBindingSecrets
// (binding_secrets.go) and PruneAddOnSecrets (addon_secrets.go) apply before interpolating a
// name/namespace into a `kubectl delete` command. A name reaches these functions from a
// DB-persisted config snapshot / the live API server; the guard is the fail-closed line that
// keeps a tampered snapshot from smuggling shell or YAML through. Anything that is not a plain
// DNS label MUST be rejected.
func TestK8sNameGuard_FailClosed(t *testing.T) {
	valid := []string{
		"db-primary",
		"x",
		"a-b-c",
		"external-secret-0",
		"addon-db-primary-app",
		"databases",
	}
	for _, n := range valid {
		if !k8sNameRe.MatchString(n) {
			t.Errorf("valid DNS label %q was rejected by the guard", n)
		}
	}

	// Each of these could alter the emitted kubectl command (or the seeded YAML) if it slipped
	// through — command injection, argument injection, or an illegal k8s name.
	malicious := []string{
		"",               // empty
		"db-x; rm -rf /", // command chaining
		"$(whoami)",      // command substitution
		"`id`",           // backtick substitution
		"a b",            // whitespace / extra arg
		"UPPER",          // uppercase (illegal DNS label)
		"-leading",       // leading hyphen
		"trailing-",      // trailing hyphen
		"a/b",            // path separator
		"ns\nname",       // embedded newline
		"a.b",            // dot (not a single label)
		"name--ok?no",    // question mark
		"under_score",    // underscore (illegal in a DNS label)
	}
	for _, n := range malicious {
		if k8sNameRe.MatchString(n) {
			t.Errorf("guard accepted an unsafe name %q — fail-closed broken", n)
		}
	}
}

// TestReadAddOnHealth_EmptyNames covers the short-circuit: with no names requested there is no
// cluster read at all and the result is an empty map (never a nil deref, never a spurious
// kubectl call).
func TestReadAddOnHealth_EmptyNames(t *testing.T) {
	out := ReadAddOnHealth(nil, &strings.Builder{}, &strings.Builder{})
	if out == nil {
		t.Fatal("ReadAddOnHealth must never return a nil map")
	}
	if len(out) != 0 {
		t.Fatalf("empty request must yield an empty map, got %v", out)
	}
}

// TestReadDataEndpoints_NoClusterOmits verifies the best-effort contract: with no reachable
// cluster (kubectl fails or returns no matching Services), a data-service add-on is simply
// omitted from the result — the honest "no endpoint" state — rather than producing a guessed
// endpoint or panicking. Robust to whether kubectl is present in the test host: either way no
// Service matches the release label here, so the add-on must not appear.
func TestReadDataEndpoints_NoClusterOmits(t *testing.T) {
	addons := []types.AddOnInstall{
		{ID: "db-primary", Mode: "managed", Namespace: "databases", Chart: "cluster", Version: "1.0.0"},
		{ID: "grafana", Mode: "managed", Namespace: "monitoring", Chart: "grafana", Version: "1.0.0"}, // not a data service — skipped outright
	}
	var stdout, stderr strings.Builder
	out := ReadDataEndpoints(addons, &stdout, &stderr)

	if _, ok := out["db-primary"]; ok {
		t.Errorf("with no reachable Service, db-primary must be omitted (honest no-endpoint), got %v", out["db-primary"])
	}
	if _, ok := out["grafana"]; ok {
		t.Error("a non data-service add-on must never get an endpoint row")
	}
	// A guessed endpoint would show up in stdout as "id → host:port"; nothing should be printed.
	if strings.Contains(stdout.String(), "→") {
		t.Errorf("no endpoint should be emitted without a real Service; stdout was:\n%s", stdout.String())
	}
}

// TestPruneChartBindingSecrets_FailClosedNoDelete verifies the prune is fail-closed and
// panic-safe with no reachable cluster: it must NOT report pruning anything (there is nothing
// to list), matching the best-effort discipline of its PruneAddOnSecrets sibling.
func TestPruneChartBindingSecrets_FailClosedNoDelete(t *testing.T) {
	var stdout, stderr strings.Builder
	PruneChartBindingSecrets([]string{"binding-a", "binding-b"}, &stdout, &stderr)

	// Nothing is listable in the test env, so nothing may be reported as pruned.
	if strings.Contains(stdout.String(), "Pruning") {
		t.Errorf("prune fired without a valid cluster listing; stdout was:\n%s", stdout.String())
	}
}
