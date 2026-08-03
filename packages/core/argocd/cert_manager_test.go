// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// certManagerFacts builds facts for `provider` with every input the cert-manager gate needs
// already satisfied, so each test can knock out exactly ONE of them and prove that alone closes
// the gate. Building "all present" once is what keeps the negative cases honest: a test that
// constructs a nearly-empty struct passes for whichever reason happens to fire first.
func certManagerFacts(provider string) *InfraFacts {
	f := &InfraFacts{
		Provider:           provider,
		Region:             "us-east-1",
		DomainName:         "demo.example.com",
		DNSZoneID:          "Z123456",
		DNSEnabled:         true,
		ManagedCertificate: true,
	}
	switch provider {
	case "aws":
		f.IRSAExternalDNSArn = "arn:aws:iam::acct-123:role/demo-external-dns"
	case "gcp":
		f.GCPProjectID = "demo-proj"
		f.GCPExternalDNSSA = "external-dns@demo-proj.iam.gserviceaccount.com"
		f.GCPDNSZoneName = "demo-zone"
	case "azure":
		f.AzureExternalDNSClient = "11111111-1111-1111-1111-111111111111"
		f.AzureResourceGroup = "rg-demo"
		f.AzureSubscriptionID = "22222222-2222-2222-2222-222222222222"
		f.AzureTenantID = "33333333-3333-3333-3333-333333333333"
	}
	return f
}

// TestCertManagerGateMatchesTemplate pins the template's render gate to the SINGLE Go predicate,
// by parsing the file rather than trusting the comment above it.
//
// This is the cert-manager shape of TestMetricsServerGateMatchesTemplate, and it pins something
// slightly stronger. metrics-server's gate spells its providers out in the YAML, so that test
// compares two lists. Here the whole point of the design is that the YAML holds NO copy of the
// condition at all — it delegates to .CertManagerEnabled, which certManagerDecision,
// CleanupSkippedInfraServices and EnsureCertManagerIssuer also read. So what must be pinned is
// that the delegation is still intact: the moment someone "helpfully" inlines the `and` chain
// into the template, the four readers can drift, and this test fails instead.
func TestCertManagerGateMatchesTemplate(t *testing.T) {
	path := filepath.Join(templatesDir(t), "cert-manager.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	// The gate is the first `{{ if }}` action in the file.
	gate := regexp.MustCompile(`\{\{-?\s*if\s+([^}]*?)\s*-?\}\}`).FindSubmatch(b)
	if gate == nil {
		t.Fatalf("no {{ if }} gate found in %s — cert-manager renders UNCONDITIONALLY, which ships an issuer-less controller on clouds that cannot solve a DNS01 challenge", path)
	}
	if got := strings.TrimSpace(string(gate[1])); got != ".CertManagerEnabled" {
		t.Fatalf("cert-manager gate DRIFT: template %s gates on %q, but the single source of truth is the .CertManagerEnabled method.\n"+
			"Inlining the condition here forks it from certManagerDecision, CleanupSkippedInfraServices and EnsureCertManagerIssuer, which all read the method.", path, got)
	}

	// The identity-annotation arms must name exactly the clouds the solver table admits — an arm
	// for a cloud with no solver ships an annotation no identity binding backs, and a MISSING arm
	// ships an empty ServiceAccount for a cloud that does, which fails only at challenge time.
	//
	// Scoped to the serviceAccount `annotations:` block, NOT the whole file. Scanning the file
	// caught nothing: `eq .Provider "azure"` also appears in the podLabels block below, so
	// deleting the azure ANNOTATION arm left the whole-file provider set unchanged and this
	// assertion passed a template that renders an identity-less ServiceAccount on AKS.
	annStart := bytes.Index(b, []byte("annotations:"))
	if annStart < 0 {
		t.Fatalf("no serviceAccount annotations block in %s — no cloud identity would be bound at all", path)
	}
	annEnd := bytes.Index(b[annStart:], []byte("{{- end }}"))
	if annEnd < 0 {
		t.Fatalf("serviceAccount annotations block in %s is not closed — cannot scope the per-cloud check", path)
	}
	annBlock := b[annStart : annStart+annEnd]

	found := map[string]bool{}
	for _, m := range regexp.MustCompile(`eq\s+\.Provider\s+"([a-z]+)"`).FindAllSubmatch(annBlock, -1) {
		found[string(m[1])] = true
	}
	want := map[string]bool{}
	for cloud := range certManagerDNS01Solvers {
		want[cloud] = true
	}
	if !equalCertManagerSets(found, want) {
		t.Fatalf("cert-manager identity-annotation DRIFT:\n  template %s annotates: %v\n  certManagerDNS01Solvers:  %v\nThey must match — a cloud in one and not the other either ships an unbacked annotation or an identity-less ServiceAccount.",
			path, sortedCertManagerKeys(found), sortedCertManagerKeys(want))
	}

	// And each arm must carry that cloud's ACTUAL identity key. The arm existing is not enough:
	// the whole mechanism is the annotation, so name the key each cloud's binding depends on.
	for cloud, key := range map[string]string{
		"aws":   "eks.amazonaws.com/role-arn",
		"gcp":   "iam.gke.io/gcp-service-account",
		"azure": "azure.workload.identity/client-id",
	} {
		if _, admits := certManagerDNS01Solvers[cloud]; !admits {
			continue
		}
		if !bytes.Contains(annBlock, []byte(key)) {
			t.Errorf("%s renders no %q annotation — cert-manager's ServiceAccount would have no identity and every DNS01 challenge would fail at token exchange", cloud, key)
		}
	}
}

func equalCertManagerSets(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if v != b[k] {
			return false
		}
	}
	return true
}

func sortedCertManagerKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// TestCertManagerRendersOnlyWhereItCanIssue is the honesty test: the three clouds with an in-box
// DNS01 solver render, and the two without render NOTHING. A ClusterIssuer that cannot solve is
// worse than none — every Challenge sits pending forever and nothing reports it as broken.
func TestCertManagerRendersOnlyWhereItCanIssue(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure"} {
		f := certManagerFacts(provider)
		if !f.CertManagerEnabled() {
			t.Errorf("%s: cert-manager must render with a full fact set, got solver %q", provider, f.CertManagerSolver())
		}
	}
	for _, provider := range []string{"alibaba", "hetzner", "digitalocean"} {
		f := certManagerFacts(provider)
		if f.CertManagerEnabled() {
			t.Errorf("%s has no in-box cert-manager DNS01 solver — it must NOT render an issuer", provider)
		}
		if got := certManagerDecision(f).Status; got != infraStatusSkipped {
			t.Errorf("%s: decision status = %q, want skipped", provider, got)
		}
	}
}

// TestCertManagerFailsClosedOnEachMissingFact knocks out ONE input at a time. Each of these is a
// separate way to end up with a controller that installs and an issuer that never issues, which
// is why the gate checks them individually rather than trusting the provider switch.
func TestCertManagerFailsClosedOnEachMissingFact(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		break_   func(f *InfraFacts)
	}{
		{"switch off", "aws", func(f *InfraFacts) { f.ManagedCertificate = false }},
		{"dns disabled", "aws", func(f *InfraFacts) { f.DNSEnabled = false }},
		{"no domain", "aws", func(f *InfraFacts) { f.DomainName = "" }},
		{"aws without the external-dns IRSA role", "aws", func(f *InfraFacts) { f.IRSAExternalDNSArn = "" }},
		{"gcp without the workload-identity GSA", "gcp", func(f *InfraFacts) { f.GCPExternalDNSSA = "" }},
		{"gcp without the managed-zone name", "gcp", func(f *InfraFacts) { f.GCPDNSZoneName = "" }},
		{"gcp without the project id", "gcp", func(f *InfraFacts) { f.GCPProjectID = "" }},
		{"azure without the managed-identity client id", "azure", func(f *InfraFacts) { f.AzureExternalDNSClient = "" }},
		{"azure without the resource group", "azure", func(f *InfraFacts) { f.AzureResourceGroup = "" }},
		{"azure without the subscription id", "azure", func(f *InfraFacts) { f.AzureSubscriptionID = "" }},
		{"azure without the tenant id", "azure", func(f *InfraFacts) { f.AzureTenantID = "" }},
		// A non-native DNS connector means the cloud's own zone is not authoritative for the
		// domain, so a route53/clouddns/azuredns solver would write its TXT record into a zone
		// the ACME server never queries — an issuer that looks fine and can never succeed.
		{"cloudflare connector on aws", "aws", func(f *InfraFacts) { f.DNSConnector = "cloudflare" }},
		{"cloudflare connector on gcp", "gcp", func(f *InfraFacts) { f.DNSConnector = "cloudflare" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := certManagerFacts(tc.provider)
			if !f.CertManagerEnabled() {
				t.Fatalf("precondition: %s must be enabled before the knock-out", tc.provider)
			}
			tc.break_(f)
			if f.CertManagerEnabled() {
				t.Errorf("gate stayed OPEN after %q — cert-manager would install and never issue", tc.name)
			}
			d := certManagerDecision(f)
			if d.Status != infraStatusSkipped {
				t.Errorf("decision = %q, want skipped", d.Status)
			}
			if strings.TrimSpace(d.Reason) == "" {
				t.Error("a skipped decision must carry a reason — the console renders it verbatim")
			}
		})
	}
}

// TestCertManagerIssuerManifest checks the rendered ClusterIssuer per cloud: the right solver
// stanza, the identity-derived fields actually interpolated, and — the part that matters most —
// no empty value anywhere. An empty `subscriptionID:` or `project:` is accepted by the API server
// and then fails only at challenge time, inside a certificate that simply never appears.
func TestCertManagerIssuerManifest(t *testing.T) {
	cases := map[string][]string{
		"aws": {
			"route53:", "region: us-east-1", "hostedZoneID: Z123456",
		},
		"gcp": {
			"cloudDNS:", "project: demo-proj", "hostedZoneName: demo-zone",
		},
		"azure": {
			"azureDNS:",
			"subscriptionID: 22222222-2222-2222-2222-222222222222",
			"resourceGroupName: rg-demo",
			"tenantID: 33333333-3333-3333-3333-333333333333",
			"clientID: 11111111-1111-1111-1111-111111111111",
			"hostedZoneName: demo.example.com",
		},
	}
	for provider, wants := range cases {
		t.Run(provider, func(t *testing.T) {
			got, err := certManagerIssuerManifest(certManagerFacts(provider))
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if got == "" {
				t.Fatal("no manifest rendered for a fully-satisfied fact set")
			}
			for _, want := range wants {
				if !strings.Contains(got, want) {
					t.Errorf("manifest missing %q:\n%s", want, got)
				}
			}
			// The issuer must be scoped to the project's own zone, so it can never be used to
			// attempt a challenge for a domain this deploy does not own.
			if !strings.Contains(got, "dnsZones:") || !strings.Contains(got, "- demo.example.com") {
				t.Errorf("issuer is not scoped to the project's dnsZones:\n%s", got)
			}
			if !strings.Contains(got, "name: "+CertManagerIssuerName) {
				t.Errorf("issuer name is not %q:\n%s", CertManagerIssuerName, got)
			}
			// No half-rendered key. A trailing-colon line means a fact interpolated empty.
			for _, line := range strings.Split(got, "\n") {
				trimmed := strings.TrimSpace(line)
				if trimmed == "" || strings.HasSuffix(trimmed, ":") || strings.HasPrefix(trimmed, "-") {
					continue
				}
				if strings.HasSuffix(trimmed, ": ") || strings.HasSuffix(trimmed, ":") {
					t.Errorf("empty value rendered on line %q — the API server accepts it and the certificate then never issues:\n%s", trimmed, got)
				}
			}
			// Exactly ONE solver stanza: the arms are mutually exclusive, and two would make the
			// issuer's behaviour depend on cert-manager's ordering rather than on our gate.
			solvers := 0
			for _, s := range []string{"route53:", "cloudDNS:", "azureDNS:"} {
				if strings.Contains(got, s) {
					solvers++
				}
			}
			if solvers != 1 {
				t.Errorf("want exactly 1 solver stanza, got %d:\n%s", solvers, got)
			}

			// PARSE it. Every check above is a substring match, and substring matches cannot see
			// a broken document: a mis-indented solver block still "contains" every string we
			// looked for, and kubectl would reject it (or, worse, accept it with the solver
			// nested under the wrong key) only at deploy time on a real cluster.
			var doc struct {
				APIVersion string `yaml:"apiVersion"`
				Kind       string `yaml:"kind"`
				Metadata   struct {
					Name string `yaml:"name"`
				} `yaml:"metadata"`
				Spec struct {
					ACME struct {
						Server  string `yaml:"server"`
						Solvers []struct {
							DNS01    map[string]map[string]any `yaml:"dns01"`
							Selector struct {
								DNSZones []string `yaml:"dnsZones"`
							} `yaml:"selector"`
						} `yaml:"solvers"`
					} `yaml:"acme"`
				} `yaml:"spec"`
			}
			if err := yaml.Unmarshal([]byte(got), &doc); err != nil {
				t.Fatalf("rendered ClusterIssuer is not valid YAML: %v\n%s", err, got)
			}
			if doc.APIVersion != "cert-manager.io/v1" || doc.Kind != "ClusterIssuer" {
				t.Errorf("wrong apiVersion/kind: %q %q", doc.APIVersion, doc.Kind)
			}
			if doc.Metadata.Name != CertManagerIssuerName {
				t.Errorf("metadata.name = %q, want %q", doc.Metadata.Name, CertManagerIssuerName)
			}
			if len(doc.Spec.ACME.Solvers) != 1 {
				t.Fatalf("want exactly 1 parsed solver, got %d:\n%s", len(doc.Spec.ACME.Solvers), got)
			}
			solver := doc.Spec.ACME.Solvers[0]
			// The dns01 block must hold exactly the one provider key, correctly NESTED — this is
			// the assertion a substring match cannot make.
			if len(solver.DNS01) != 1 {
				t.Errorf("dns01 must hold exactly one solver key, got %v:\n%s", solver.DNS01, got)
			}
			for key, fields := range solver.DNS01 {
				if len(fields) == 0 {
					t.Errorf("dns01.%s parsed with NO fields — the block is mis-indented:\n%s", key, got)
				}
				for fk, fv := range fields {
					if s, ok := fv.(string); ok && strings.TrimSpace(s) == "" {
						t.Errorf("dns01.%s.%s is empty — the certificate would never issue:\n%s", key, fk, got)
					}
				}
			}
			if len(solver.Selector.DNSZones) != 1 || solver.Selector.DNSZones[0] != "demo.example.com" {
				t.Errorf("solver is not scoped to the project's zone: %v", solver.Selector.DNSZones)
			}
		})
	}
}

// TestCertManagerIssuerManifestEmptyWhenSkipped ties the issuer to the SAME gate as the
// Application: a cloud that renders no controller must never get a dangling ClusterIssuer, and a
// cloud that renders one must never be left without an issuer.
func TestCertManagerIssuerManifestEmptyWhenSkipped(t *testing.T) {
	for _, provider := range []string{"alibaba", "hetzner"} {
		got, err := certManagerIssuerManifest(certManagerFacts(provider))
		if err != nil {
			t.Fatalf("%s: %v", provider, err)
		}
		if got != "" {
			t.Errorf("%s renders no cert-manager controller, so it must render no ClusterIssuer either:\n%s", provider, got)
		}
	}
}

// TestCertManagerRenderThroughRealPipeline drives the ACTUAL render path (RenderApplications
// over the real infra/templates/argocd directory), not just the gate predicate. That matters for
// two reasons the unit tests above cannot cover: RenderApplications runs InjectCommonLabels,
// which PARSES the rendered YAML — so a malformed Application fails here rather than at deploy
// time — and render.go's "empty render is skipped" rule is what actually makes the per-cloud
// exclusion work, so this proves the file genuinely disappears rather than rendering blank.
func TestCertManagerRenderThroughRealPipeline(t *testing.T) {
	const file = "cert-manager.yaml"

	for _, provider := range []string{"aws", "gcp", "azure"} {
		t.Run(provider+" renders", func(t *testing.T) {
			files := renderAll(t, certManagerFacts(provider))
			got, ok := files[file]
			if !ok {
				t.Fatalf("%s did not render on %s — the managed-certificate switch would do nothing", file, provider)
			}
			for _, want := range []string{
				"kind: Application",
				"name: cert-manager",
				"chart: cert-manager",
				"repoURL: https://charts.jetstack.io",
			} {
				if !strings.Contains(got, want) {
					t.Errorf("rendered %s missing %q:\n%s", file, want, got)
				}
			}
			// A dangling `{{` means a branch was left half-written; the YAML would still parse.
			if strings.Contains(got, "{{") {
				t.Errorf("rendered %s still contains an unexecuted template action:\n%s", file, got)
			}
			// The identity annotation must have a VALUE. An empty one is valid YAML and valid to
			// the API server, and then every DNS01 challenge fails at token exchange.
			for _, empty := range []string{
				"eks.amazonaws.com/role-arn:\n",
				"iam.gke.io/gcp-service-account:\n",
				"azure.workload.identity/client-id:\n",
			} {
				if strings.Contains(got, empty) {
					t.Errorf("rendered %s has an EMPTY identity annotation (%q):\n%s", file, strings.TrimSpace(empty), got)
				}
			}
		})
	}

	// The clouds with no in-box DNS01 solver must produce NO FILE AT ALL, not an empty or
	// issuer-less one — render.go drops an empty render, and that is the whole exclusion mechanism.
	for _, provider := range []string{"alibaba", "hetzner"} {
		t.Run(provider+" is absent", func(t *testing.T) {
			files := renderAll(t, certManagerFacts(provider))
			if got, ok := files[file]; ok {
				t.Errorf("%s has no cert-manager DNS01 solver, so %s must not render at all:\n%s", provider, file, got)
			}
		})
	}
}
