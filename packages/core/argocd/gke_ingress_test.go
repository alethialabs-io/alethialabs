// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// gcpRootOutputsPath is the REAL template this package's gcp facts read from. Tests below parse it
// rather than a fixture, so a renamed output reddens here instead of on a live cluster.
const gcpRootOutputsPath = "../../../infra/templates/project/gcp/outputs.tf"

// TestBuildFromOutputs_GCPIngressFacts locks the output→fact wiring for the reference the GKE
// platform ingress attaches: the Cloud Armor policy.
//
// It used to lock TWO. The Google-managed SSL certificate went with #1858 — GCP's certificate is
// issued in-cluster by cert-manager now, so there is no `cloud_dns_managed_certificate_name` output
// and no fact to read it into. What remains is the armor policy, and the properties that mattered
// for both still matter for it: it is a NAME, not an id (a BackendConfig's
// `spec.securityPolicy.name` takes a bare name and rejects anything else), and it is GCP-only — no
// other template exports the key, and reading it elsewhere would hand the runner a reference it
// cannot bind.
func TestBuildFromOutputs_GCPIngressFacts(t *testing.T) {
	const policy = "alethia-nl-production-armor-policy"

	t.Run("gcp reads the armor policy", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{
			"cloud_armor_policy_name": policy,
		}, &types.ProjectConfig{Provider: "gcp"})
		if f.GCPArmorPolicy != policy {
			t.Errorf("GCPArmorPolicy = %q, want %q", f.GCPArmorPolicy, policy)
		}
	})

	// The WAF switch off makes the output null. ExtractOutput yields "" — the "attach nothing"
	// signal. A present-but-empty value is strictly worse than an absent one: an empty
	// securityPolicy name is a BackendConfig the GKE ingress controller refuses outright.
	t.Run("a null output leaves the fact empty and skips the decision", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{
			"cloud_armor_policy_name": nil,
		}, &types.ProjectConfig{Provider: "gcp"})
		if f.GCPArmorPolicy != "" {
			t.Fatalf("a null output must yield an empty fact, got policy=%q", f.GCPArmorPolicy)
		}
		if d := decisionFor(t, InfraServiceDecisions(f), "waf"); d.Status != infraStatusSkipped {
			t.Errorf("waf = %s, want skipped without a policy", d.Status)
		}
		// And with no cluster and no certificate ask, there is no managed ArgoCD URL either.
		if d := decisionFor(t, InfraServiceDecisions(f), "argocd-url"); d.Status != infraStatusSkipped {
			t.Errorf("argocd-url = %s, want skipped with nothing provisioned", d.Status)
		}
	})

	t.Run("no other cloud reads the key", func(t *testing.T) {
		for _, p := range []string{"aws", "azure", "alibaba", "hetzner", "digitalocean"} {
			f := BuildFromOutputs(map[string]interface{}{
				"cloud_armor_policy_name": policy,
			}, &types.ProjectConfig{Provider: types.CloudProvider(p)})
			if f.GCPArmorPolicy != "" {
				t.Errorf("%s: read a GCP-only output (policy=%q)", p, f.GCPArmorPolicy)
			}
		}
	})
}

// TestGCPFactsReadOnlyDeclaredRootOutputs sweeps EVERY output key the `case "gcp"` arm of
// BuildFromOutputs reads and asserts the gcp root template actually declares it.
//
// This is the guard `GCPIngressSA` needed and never had. It is wired to `ingress_service_account`,
// which no template has ever exported, so ExtractOutput has returned "" on every deploy since the
// day it was written — a fact that is not wrong, merely permanently absent, which is the failure
// mode nothing reports. Adding two more facts to the same arm without a sweep would have been an
// invitation to repeat it.
//
// Both halves are parsed from real files (the Go source and the .tf), never from a list maintained
// by hand, so a rename on either side reddens this test. The one known-bad key is named in
// gcpFactOutputExceptions with its reason — deleting the fact deletes the exception, and until then
// the exception documents the debt instead of hiding it.
func TestGCPFactsReadOnlyDeclaredRootOutputs(t *testing.T) {
	// `ingress_service_account`: see the field comment on InfraFacts.GCPIngressSA. GKE's Ingress
	// controller runs in the Google-managed control plane and authenticates as the cluster's own
	// service agent, so there is no in-cluster identity to annotate and no output to export. The
	// fact is dead; removing it is a rename this lane deliberately kept out of scope.
	gcpFactOutputExceptions := map[string]string{
		"ingress_service_account": "no GKE ingress identity exists to export — the controller is control-plane managed",
	}

	declared := declaredRootOutputs(t, gcpRootOutputsPath)
	for _, key := range extractOutputKeysForProviderCase(t, "infra_facts.go", "gcp") {
		if _, excused := gcpFactOutputExceptions[key]; excused {
			if _, ok := declared[key]; ok {
				t.Errorf("output %q IS declared now — drop it from gcpFactOutputExceptions", key)
			}
			continue
		}
		if _, ok := declared[key]; !ok {
			t.Errorf("BuildFromOutputs' gcp arm reads output %q, which %s does not declare — the fact would be permanently empty and nothing would say so", key, gcpRootOutputsPath)
		}
	}
}

// declaredRootOutputs parses `output "<name>" {` declarations out of a template's outputs.tf.
func declaredRootOutputs(t *testing.T, path string) map[string]struct{} {
	t.Helper()
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	re := regexp.MustCompile(`(?m)^output\s+"([^"]+)"\s*\{`)
	out := map[string]struct{}{}
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		out[m[1]] = struct{}{}
	}
	if len(out) == 0 {
		t.Fatalf("parsed no outputs from %s — the parser has drifted from the file format", path)
	}
	return out
}

// extractOutputKeysForProviderCase pulls every `ExtractOutput(outputs, "<key>")` literal out of ONE
// `case "<provider>":` arm of the BuildFromOutputs switch, stopping at the next `case`/`default`.
//
// Anchored on the FUNCTION first: `case "gcp":` also appears in XacctSecretStore and DNSProvider,
// and matching the first occurrence in the file found an arm with no ExtractOutput calls at all —
// which would have made this guard vacuously green rather than red.
func extractOutputKeysForProviderCase(t *testing.T, path, provider string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	src := string(raw)
	fn := strings.Index(src, "func BuildFromOutputs(")
	if fn < 0 {
		t.Fatalf("no BuildFromOutputs found in %s", path)
	}
	src = src[fn:]
	start := strings.Index(src, "\tcase \""+provider+"\":")
	if start < 0 {
		t.Fatalf("no `case %q:` arm found in BuildFromOutputs (%s)", provider, path)
	}
	rest := src[start+1:]
	end := len(rest)
	for _, marker := range []string{"\n\tcase \"", "\n\tdefault:"} {
		if i := strings.Index(rest, marker); i >= 0 && i < end {
			end = i
		}
	}
	re := regexp.MustCompile(`ExtractOutput\(outputs,\s*"([^"]+)"\)`)
	var keys []string
	for _, m := range re.FindAllStringSubmatch(rest[:end], -1) {
		keys = append(keys, m[1])
	}
	if len(keys) == 0 {
		t.Fatalf("parsed no ExtractOutput keys from the %q arm of %s — the parser has drifted", provider, path)
	}
	return keys
}

// TestGKEBackendConfigManifest pins the object that is the ENTIRE Cloud Armor attach on GCP:
// a policy bound to a GCLB backend service and nothing else. It also pins the fail-closed
// direction, which matters more than the happy path — a BackendConfig with an empty
// securityPolicy name is not "no WAF", it is one the ingress controller rejects, and rendering it
// would turn "the operator left the switch off" into "the ArgoCD ingress never programs".
func TestGKEBackendConfigManifest(t *testing.T) {
	t.Run("binds the policy by name", func(t *testing.T) {
		got, err := GKEBackendConfigManifest("argocd", "alethia-nl-production-armor-policy")
		if err != nil {
			t.Fatalf("GKEBackendConfigManifest: %v", err)
		}
		var doc struct {
			APIVersion string `yaml:"apiVersion"`
			Kind       string `yaml:"kind"`
			Metadata   struct {
				Name      string `yaml:"name"`
				Namespace string `yaml:"namespace"`
			} `yaml:"metadata"`
			Spec struct {
				SecurityPolicy struct {
					Name string `yaml:"name"`
				} `yaml:"securityPolicy"`
			} `yaml:"spec"`
		}
		if err := yaml.Unmarshal([]byte(got), &doc); err != nil {
			t.Fatalf("rendered BackendConfig is not valid YAML: %v\n%s", err, got)
		}
		if doc.APIVersion != "cloud.google.com/v1" || doc.Kind != "BackendConfig" {
			t.Errorf("apiVersion/kind = %q/%q, want cloud.google.com/v1 BackendConfig", doc.APIVersion, doc.Kind)
		}
		if doc.Metadata.Namespace != "argocd" {
			t.Errorf("namespace = %q, want argocd", doc.Metadata.Namespace)
		}
		// The name must equal the constant the Service annotation points at, or GKE looks up a
		// BackendConfig that does not exist and refuses to program the backend service.
		if doc.Metadata.Name != GKEBackendConfigName {
			t.Errorf("name = %q, want %q (the value the Service annotation names)", doc.Metadata.Name, GKEBackendConfigName)
		}
		if doc.Spec.SecurityPolicy.Name != "alethia-nl-production-armor-policy" {
			t.Errorf("securityPolicy.name = %q", doc.Spec.SecurityPolicy.Name)
		}
	})

	t.Run("refuses an empty policy name", func(t *testing.T) {
		if _, err := GKEBackendConfigManifest("argocd", ""); err == nil {
			t.Fatal("an empty securityPolicy name must be refused, not rendered")
		}
		if _, err := GKEBackendConfigManifest("argocd", "   "); err == nil {
			t.Fatal("a whitespace-only securityPolicy name must be refused")
		}
	})

	t.Run("refuses an empty namespace", func(t *testing.T) {
		if _, err := GKEBackendConfigManifest("", "p"); err == nil {
			t.Fatal("an empty namespace must be refused")
		}
	})
}

// TestGKEArgoServerValues pins the chart values that make the GKE Ingress exist and carry its TLS
// + the BackendConfig. Both directions of the Cloud Armor half matter and fail differently: with a
// policy the Service must be annotated (or the load balancer is programmed with no security policy
// and the WAF switch means nothing), and WITHOUT one the annotation key must be absent entirely (or
// GKE waits on a BackendConfig nobody rendered and the ingress stalls).
//
// TLS comes from a cert-manager Secret now, not `pre-shared-cert` (#1858). `tls: true` is the whole
// contract with argo-cd 8.6.4 — verified against the chart's values.yaml, which has no `tlsSecret`
// key — and `allow-http: "false"` is asserted alongside it because cert-manager issues
// ASYNCHRONOUSLY: without it the load balancer would answer plaintext :80 for the ArgoCD API during
// the window before the Secret lands.
func TestGKEArgoServerValues(t *testing.T) {
	const host = "argocd.example.com"

	parse := func(t *testing.T, raw string) map[string]interface{} {
		t.Helper()
		var v map[string]interface{}
		if err := yaml.Unmarshal([]byte(raw), &v); err != nil {
			t.Fatalf("rendered values are not valid YAML: %v\n%s", err, raw)
		}
		return v
	}

	t.Run("armored: ingress, TLS and backend-config all present", func(t *testing.T) {
		raw, err := GKEArgoServerValues(host, CertManagerIssuerName, GKEBackendConfigName)
		if err != nil {
			t.Fatalf("GKEArgoServerValues: %v", err)
		}
		parse(t, raw)
		for _, want := range []string{
			"ingressClassName: gce",
			"hostname: " + host,
			"tls: true",
			`cert-manager.io/cluster-issuer: "` + CertManagerIssuerName + `"`,
			`kubernetes.io/ingress.allow-http: "false"`,
			`cloud.google.com/backend-config: '{"default":"` + GKEBackendConfigName + `"}'`,
			`cloud.google.com/neg: '{"ingress": true}'`,
			`server.insecure: "true"`,
		} {
			if !strings.Contains(raw, want) {
				t.Errorf("values missing %q:\n%s", want, raw)
			}
		}
		// nginx would have been the wrong controller: its L4 pass-through load balancer cannot
		// carry a Cloud Armor policy at all.
		if strings.Contains(raw, "nginx") {
			t.Errorf("values reference nginx — Cloud Armor binds to a GCLB backend service, which only the gce class provisions:\n%s", raw)
		}
		// Google documents Secrets and pre-shared certificates as SEPARATE options, not
		// complementary ones, and the resource the annotation named no longer exists.
		if strings.Contains(raw, "pre-shared-cert") {
			t.Errorf("values still carry the pre-shared-cert annotation — the certificate it names was deleted with #1858:\n%s", raw)
		}
	})

	t.Run("no policy emits no backend-config key at all", func(t *testing.T) {
		raw, err := GKEArgoServerValues(host, CertManagerIssuerName, "")
		if err != nil {
			t.Fatalf("GKEArgoServerValues: %v", err)
		}
		parse(t, raw)
		if strings.Contains(raw, "backend-config") {
			t.Errorf("values name a BackendConfig with no Cloud Armor policy rendered — GKE would stall on it:\n%s", raw)
		}
		// The rest of the ingress must be untouched: this is the common case (WAF switch off).
		if !strings.Contains(raw, "ingressClassName: gce") || !strings.Contains(raw, "tls: true") {
			t.Errorf("values lost the ingress when the WAF switch was off:\n%s", raw)
		}
	})

	t.Run("refuses to render without an issuer or a host", func(t *testing.T) {
		if _, err := GKEArgoServerValues(host, "", GKEBackendConfigName); err == nil {
			t.Error("a GKE Ingress with no cert-manager issuer never gets a TLS Secret — with allow-http=false it would serve nothing at all, so it must be refused")
		}
		if _, err := GKEArgoServerValues("", CertManagerIssuerName, ""); err == nil {
			t.Error("an empty host must be refused")
		}
	})
}
