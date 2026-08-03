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

// TestBuildFromOutputs_GCPIngressFacts locks the output→fact wiring for the two references the GKE
// platform ingress attaches: the Google-managed SSL certificate and the Cloud Armor policy.
//
// Both are NAMES, not ids — `ingress.gcp.kubernetes.io/pre-shared-cert` and a BackendConfig's
// `spec.securityPolicy.name` each take a bare name and reject anything else — and both are GCP-only:
// no other template exports either key, and reading one on another cloud would hand the runner a
// reference it cannot bind.
func TestBuildFromOutputs_GCPIngressFacts(t *testing.T) {
	const cert = "alethia-nl-production-platform-cert"
	const policy = "alethia-nl-production-armor-policy"

	t.Run("gcp reads both keys", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{
			"cloud_dns_managed_certificate_name": cert,
			"cloud_armor_policy_name":            policy,
		}, &types.ProjectConfig{Provider: "gcp"})
		if f.GCPManagedCertName != cert {
			t.Errorf("GCPManagedCertName = %q, want %q", f.GCPManagedCertName, cert)
		}
		if f.GCPArmorPolicy != policy {
			t.Errorf("GCPArmorPolicy = %q, want %q", f.GCPArmorPolicy, policy)
		}
	})

	// Both switches off make both outputs null. ExtractOutput yields "" — the "render no ingress" /
	// "attach nothing" signal. A present-but-empty value on either side is strictly worse than an
	// absent one: an empty pre-shared-cert leaves the ArgoCD API on plain HTTP, and an empty
	// securityPolicy name is a BackendConfig the GKE ingress controller refuses.
	t.Run("null outputs leave both facts empty and skip both decisions", func(t *testing.T) {
		f := BuildFromOutputs(map[string]interface{}{
			"cloud_dns_managed_certificate_name": nil,
			"cloud_armor_policy_name":            nil,
		}, &types.ProjectConfig{Provider: "gcp"})
		if f.GCPManagedCertName != "" || f.GCPArmorPolicy != "" {
			t.Fatalf("null outputs must yield empty facts, got cert=%q policy=%q", f.GCPManagedCertName, f.GCPArmorPolicy)
		}
		if d := decisionFor(t, InfraServiceDecisions(f), "argocd-url"); d.Status != infraStatusSkipped {
			t.Errorf("argocd-url = %s, want skipped without a certificate", d.Status)
		}
		if d := decisionFor(t, InfraServiceDecisions(f), "waf"); d.Status != infraStatusSkipped {
			t.Errorf("waf = %s, want skipped without a policy", d.Status)
		}
	})

	t.Run("no other cloud reads the keys", func(t *testing.T) {
		for _, p := range []string{"aws", "azure", "alibaba", "hetzner", "digitalocean"} {
			f := BuildFromOutputs(map[string]interface{}{
				"cloud_dns_managed_certificate_name": cert,
				"cloud_armor_policy_name":            policy,
			}, &types.ProjectConfig{Provider: types.CloudProvider(p)})
			if f.GCPManagedCertName != "" || f.GCPArmorPolicy != "" {
				t.Errorf("%s: read a GCP-only output (cert=%q policy=%q)", p, f.GCPManagedCertName, f.GCPArmorPolicy)
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

// TestGKEArgoServerValues pins the chart values that make the GKE Ingress exist and carry the
// certificate + the BackendConfig. Both directions of the Cloud Armor half matter and fail
// differently: with a policy the Service must be annotated (or the load balancer is programmed
// with no security policy and the WAF switch means nothing), and WITHOUT one the annotation key
// must be absent entirely (or GKE waits on a BackendConfig nobody rendered and the ingress stalls).
func TestGKEArgoServerValues(t *testing.T) {
	const host = "argocd.example.com"
	const cert = "alethia-nl-production-platform-cert"

	parse := func(t *testing.T, raw string) map[string]interface{} {
		t.Helper()
		var v map[string]interface{}
		if err := yaml.Unmarshal([]byte(raw), &v); err != nil {
			t.Fatalf("rendered values are not valid YAML: %v\n%s", err, raw)
		}
		return v
	}

	t.Run("armored: ingress, certificate and backend-config all present", func(t *testing.T) {
		raw, err := GKEArgoServerValues(host, cert, GKEBackendConfigName)
		if err != nil {
			t.Fatalf("GKEArgoServerValues: %v", err)
		}
		parse(t, raw)
		for _, want := range []string{
			"ingressClassName: gce",
			"hostname: " + host,
			`ingress.gcp.kubernetes.io/pre-shared-cert: "` + cert + `"`,
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
	})

	t.Run("no policy emits no backend-config key at all", func(t *testing.T) {
		raw, err := GKEArgoServerValues(host, cert, "")
		if err != nil {
			t.Fatalf("GKEArgoServerValues: %v", err)
		}
		parse(t, raw)
		if strings.Contains(raw, "backend-config") {
			t.Errorf("values name a BackendConfig with no Cloud Armor policy rendered — GKE would stall on it:\n%s", raw)
		}
		// The rest of the ingress must be untouched: this is the common case (WAF switch off).
		if !strings.Contains(raw, "ingressClassName: gce") || !strings.Contains(raw, "pre-shared-cert") {
			t.Errorf("values lost the ingress when the WAF switch was off:\n%s", raw)
		}
	})

	t.Run("refuses to render without a certificate or a host", func(t *testing.T) {
		if _, err := GKEArgoServerValues(host, "", GKEBackendConfigName); err == nil {
			t.Error("a GKE Ingress with no pre-shared certificate would serve ArgoCD over plain HTTP — it must be refused")
		}
		if _, err := GKEArgoServerValues("", cert, ""); err == nil {
			t.Error("an empty host must be refused")
		}
	})
}
