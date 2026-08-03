// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"
)

// decisionFor returns the decision for a given service, failing the test if absent.
func decisionFor(t *testing.T, decisions []InfraServiceDecision, service string) InfraServiceDecision {
	t.Helper()
	for _, d := range decisions {
		if d.Service == service {
			return d
		}
	}
	t.Fatalf("no decision recorded for service %q", service)
	return InfraServiceDecision{}
}

// assertAllReasonsNonEmpty enforces the "honest N/A" contract: every decision — installed
// or skipped — must carry a non-empty reason.
func assertAllReasonsNonEmpty(t *testing.T, decisions []InfraServiceDecision) {
	t.Helper()
	// One per unconditional service: external-dns, external-secrets-store, cert-manager,
	// ingress, storage-class, argocd-url, apps-repo, waf. (*-xacct is conditionally appended
	// and is never present in the facts this helper is called with.)
	if len(decisions) != 8 {
		t.Fatalf("expected 8 decisions (one per service), got %d", len(decisions))
	}
	for _, d := range decisions {
		if strings.TrimSpace(d.Reason) == "" {
			t.Errorf("decision for %q (%s) has an empty reason", d.Service, d.Status)
		}
		if d.Status != infraStatusInstalled && d.Status != infraStatusSkipped {
			t.Errorf("decision for %q has unexpected status %q", d.Service, d.Status)
		}
	}
}

func TestInfraServiceDecisions_AWS(t *testing.T) {
	f := &InfraFacts{
		Provider:               "aws",
		DNSEnabled:             true,
		DomainName:             "example.com",
		DNSCredentialPresent:   true,
		ACMCertificateArn:      "arn:aws:acm:us-east-1:123:certificate/abc",
		IRSAExternalSecretsArn: "arn:aws:iam::123:role/eso",
		IRSAExternalDNSArn:     "arn:aws:iam::123:role/edns",
	}
	decisions := InfraServiceDecisions(f)
	assertAllReasonsNonEmpty(t, decisions)

	if d := decisionFor(t, decisions, "external-dns"); d.Status != infraStatusInstalled {
		t.Errorf("aws external-dns: want installed, got %s (%s)", d.Status, d.Reason)
	}
	if d := decisionFor(t, decisions, "external-secrets-store"); d.Status != infraStatusInstalled {
		t.Errorf("aws external-secrets-store: want installed, got %s (%s)", d.Status, d.Reason)
	}
	if d := decisionFor(t, decisions, "argocd-url"); d.Status != infraStatusInstalled {
		t.Errorf("aws argocd-url: want installed, got %s (%s)", d.Status, d.Reason)
	}
	if d := decisionFor(t, decisions, "ingress"); d.Status != infraStatusInstalled {
		t.Errorf("aws ingress: want installed, got %s (%s)", d.Status, d.Reason)
	}
	if d := decisionFor(t, decisions, "storage-class"); d.Status != infraStatusInstalled {
		t.Errorf("aws storage-class: want installed, got %s (%s)", d.Status, d.Reason)
	}
}

func TestInfraServiceDecisions_Hetzner(t *testing.T) {
	// With a Cloud API token present, external-dns installs via the Hetzner webhook.
	withToken := &InfraFacts{
		Provider:             "hetzner",
		DNSEnabled:           true,
		DomainName:           "example.com",
		DNSCredentialPresent: true,
	}
	decisions := InfraServiceDecisions(withToken)
	assertAllReasonsNonEmpty(t, decisions)

	if d := decisionFor(t, decisions, "external-dns"); d.Status != infraStatusInstalled {
		t.Errorf("hetzner external-dns (token present): want installed, got %s (%s)", d.Status, d.Reason)
	}

	// Without the token, external-dns is skipped with the connect-a-token reason.
	noToken := &InfraFacts{
		Provider:             "hetzner",
		DNSEnabled:           true,
		DomainName:           "example.com",
		DNSCredentialPresent: false,
	}
	decisions = InfraServiceDecisions(noToken)
	assertAllReasonsNonEmpty(t, decisions)

	edns := decisionFor(t, decisions, "external-dns")
	if edns.Status != infraStatusSkipped {
		t.Errorf("hetzner external-dns (no token): want skipped, got %s", edns.Status)
	}
	if !strings.Contains(strings.ToLower(edns.Reason), "hetzner cloud api token") {
		t.Errorf("hetzner external-dns skip reason should mention the Cloud API token, got %q", edns.Reason)
	}

	store := decisionFor(t, decisions, "external-secrets-store")
	if store.Status != infraStatusSkipped {
		t.Errorf("hetzner external-secrets-store: want skipped, got %s", store.Status)
	}
	if !strings.Contains(strings.ToLower(store.Reason), "vault connector") {
		t.Errorf("hetzner secret-store skip reason should point at the Vault connector, got %q", store.Reason)
	}

	if d := decisionFor(t, decisions, "storage-class"); d.Status != infraStatusInstalled {
		t.Errorf("hetzner storage-class: want installed, got %s (%s)", d.Status, d.Reason)
	}
	if d := decisionFor(t, decisions, "argocd-url"); d.Status != infraStatusSkipped {
		t.Errorf("hetzner argocd-url: want skipped, got %s (%s)", d.Status, d.Reason)
	}
}

func TestInfraServiceDecisions_Alibaba(t *testing.T) {
	f := &InfraFacts{
		Provider:                      "alibaba",
		DNSEnabled:                    true,
		DomainName:                    "example.com",
		DNSCredentialPresent:          true,
		AlibabaExternalSecretsRoleArn: "acs:ram::123:role/eso",
	}
	decisions := InfraServiceDecisions(f)
	assertAllReasonsNonEmpty(t, decisions)

	edns := decisionFor(t, decisions, "external-dns")
	if edns.Status != infraStatusSkipped {
		t.Errorf("alibaba external-dns: want skipped, got %s", edns.Status)
	}
	if !strings.Contains(edns.Reason, "#5019") {
		t.Errorf("alibaba external-dns skip reason should cite external-dns#5019, got %q", edns.Reason)
	}

	if d := decisionFor(t, decisions, "external-secrets-store"); d.Status != infraStatusInstalled {
		t.Errorf("alibaba external-secrets-store: want installed, got %s (%s)", d.Status, d.Reason)
	}
}

func TestInfraServiceDecisions_DNSDisabled(t *testing.T) {
	f := &InfraFacts{
		Provider:               "aws",
		DNSEnabled:             false,
		DomainName:             "example.com",
		IRSAExternalSecretsArn: "arn:aws:iam::123:role/eso",
		ACMCertificateArn:      "arn:aws:acm:us-east-1:123:certificate/abc",
	}
	decisions := InfraServiceDecisions(f)
	assertAllReasonsNonEmpty(t, decisions)

	edns := decisionFor(t, decisions, "external-dns")
	if edns.Status != infraStatusSkipped {
		t.Errorf("dns-disabled external-dns: want skipped, got %s", edns.Status)
	}
	if !strings.Contains(strings.ToLower(edns.Reason), "dns is disabled") {
		t.Errorf("dns-disabled skip reason should say DNS is disabled, got %q", edns.Reason)
	}
	// The rest of the services are unaffected by DNS being off.
	if d := decisionFor(t, decisions, "external-secrets-store"); d.Status != infraStatusInstalled {
		t.Errorf("dns-disabled external-secrets-store (aws): want installed, got %s", d.Status)
	}
}

func TestInfraServiceDecisions_GCPMissingWorkloadIdentity(t *testing.T) {
	// DNS on + domain set, but no external-dns WI SA output → honest skip citing WI.
	f := &InfraFacts{
		Provider:             "gcp",
		DNSEnabled:           true,
		DomainName:           "example.com",
		DNSCredentialPresent: true,
	}
	decisions := InfraServiceDecisions(f)
	assertAllReasonsNonEmpty(t, decisions)

	edns := decisionFor(t, decisions, "external-dns")
	if edns.Status != infraStatusSkipped {
		t.Errorf("gcp external-dns (no WI): want skipped, got %s", edns.Status)
	}
	if !strings.Contains(strings.ToLower(edns.Reason), "workload identity") {
		t.Errorf("gcp external-dns skip reason should mention workload identity, got %q", edns.Reason)
	}
}

func TestInfraServiceDecisions_AppsRepo(t *testing.T) {
	// BYOC A0.6: the apps-repo decision mirrors the user-apps.yaml render gate
	// ({{- if .AppsDestinationRepo }}). With a repo wired it is "installed" (repo-apps
	// credentialed + the "apps" app-of-apps rendered); with none it is a clean "skipped".
	// The T2 harness derives the "apps" Application from THIS decision, so the gate must be
	// exact — never installed without an actual repo.
	with := decisionFor(t, InfraServiceDecisions(&InfraFacts{AppsDestinationRepo: "https://github.com/acme/apps"}), "apps-repo")
	if with.Status != infraStatusInstalled {
		t.Errorf("apps-repo (repo wired): want installed, got %s (%s)", with.Status, with.Reason)
	}
	if !strings.Contains(strings.ToLower(with.Reason), "repo-apps") {
		t.Errorf("apps-repo installed reason should name the repo-apps credential, got %q", with.Reason)
	}

	without := decisionFor(t, InfraServiceDecisions(&InfraFacts{}), "apps-repo")
	if without.Status != infraStatusSkipped {
		t.Errorf("apps-repo (no repo): want skipped, got %s (%s)", without.Status, without.Reason)
	}
}

// hasDecision reports whether a service was recorded at all (the *-xacct decision is
// CONDITIONALLY appended, so absence is a meaningful outcome, not a test failure).
func hasDecision(decisions []InfraServiceDecision, service string) bool {
	for _, d := range decisions {
		if d.Service == service {
			return true
		}
	}
	return false
}

const xacctSvc = "external-secrets-store-xacct"

// The cross-account store is OPT-IN: with no cross-account target selected, no decision is recorded
// at all — the common-case list must stay uncluttered rather than carry a permanent "skipped" row.
func TestInfraServiceDecisions_XacctNotSelected(t *testing.T) {
	for name, f := range map[string]*InfraFacts{
		"zero value":                      {},
		"aws with only the native store":  {Provider: "aws", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso"},
		"gcp with only the native store":  {Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com"},
		"hetzner (no cloud secret store)": {Provider: "hetzner"},
	} {
		if hasDecision(InfraServiceDecisions(f), xacctSvc) {
			t.Errorf("%s: recorded a %s decision without a cross-account target selected", name, xacctSvc)
		}
	}
}

// Selected + the cluster's own external-secrets identity present ⇒ installed on every cloud, with a
// reason that names the backend so the console can render it truthfully.
func TestInfraServiceDecisions_XacctInstalled(t *testing.T) {
	cases := map[string]struct {
		facts       *InfraFacts
		wantBackend string
	}{
		"aws": {&InfraFacts{Provider: "aws", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
			SecretsXacctRef: "arn:aws:iam::999:role/read"}, "AWS Secrets Manager"},
		"gcp": {&InfraFacts{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com",
			SecretsXacctProjectID: "secrets-project-b"}, "GCP Secret Manager"},
		"azure": {&InfraFacts{Provider: "azure", AzureExternalSecretsClient: "cid",
			SecretsXacctRef: "https://target.vault.azure.net/"}, "Azure Key Vault"},
		"alibaba": {&InfraFacts{Provider: "alibaba", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso",
			SecretsXacctRef: "acs:ram::999:role/read", SecretsXacctOIDCProviderRef: "acs:ram::999:oidc-provider/ack"}, "Alibaba KMS"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			d := decisionFor(t, InfraServiceDecisions(c.facts), xacctSvc)
			if d.Status != infraStatusInstalled {
				t.Fatalf("want installed, got %s (%s)", d.Status, d.Reason)
			}
			if !strings.Contains(d.Reason, c.wantBackend) {
				t.Errorf("reason should name the backend %q, got %q", c.wantBackend, d.Reason)
			}
		})
	}
}

// FAIL-CLOSED: a target selected but the CLUSTER's own external-secrets identity missing ⇒ skipped
// with a reason, never installed. ESO would have nothing to authenticate the cross-account read as.
func TestInfraServiceDecisions_XacctSkippedFailClosed(t *testing.T) {
	cases := map[string]*InfraFacts{
		"aws without IRSA":                {Provider: "aws", SecretsXacctRef: "arn:aws:iam::999:role/read"},
		"gcp without the ESO GSA":         {Provider: "gcp", SecretsXacctProjectID: "secrets-project-b"},
		"azure without the MI client id":  {Provider: "azure", SecretsXacctRef: "https://target.vault.azure.net/"},
		"alibaba without the RRSA role":   {Provider: "alibaba", SecretsXacctRef: "acs:ram::999:role/read", SecretsXacctOIDCProviderRef: "acs:ram::999:oidc-provider/ack"},
		"alibaba without the target OIDC": {Provider: "alibaba", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", SecretsXacctRef: "acs:ram::999:role/read"},
		"a cloud with no xacct store":     {Provider: "hetzner", SecretsXacctRef: "whatever"},
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			d := decisionFor(t, InfraServiceDecisions(f), xacctSvc)
			if d.Status != infraStatusSkipped {
				t.Fatalf("want skipped (fail-closed), got %s (%s)", d.Status, d.Reason)
			}
			if d.Reason == "" {
				t.Error("a skip must carry a reason — the honest-N/A contract")
			}
		})
	}
}

// The decision and the render must agree: "installed" ⟺ the template actually emitted the store.
// They used to be independent hand-written condition lists and had already diverged — facts with an
// IRSA role and a GCP-shaped target satisfied the decision's aws branch (which checked only IRSA)
// and reported installed, while the template's aws branch, which also requires SecretsXacctRef,
// rendered nothing. A workload could then be pointed at a store that was never applied.
func TestInfraServiceDecisions_XacctMirrorsRenderGate(t *testing.T) {
	factMatrix := []*InfraFacts{
		{Provider: "aws", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso", SecretsXacctRef: "arn:aws:iam::999:role/read"},
		{Provider: "aws", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso", SecretsXacctProjectID: "p"}, // the divergence case
		{Provider: "aws", SecretsXacctRef: "arn:aws:iam::999:role/read"},
		{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com", SecretsXacctProjectID: "b"},
		{Provider: "gcp", SecretsXacctProjectID: "b"},
		{Provider: "azure", AzureExternalSecretsClient: "cid", SecretsXacctRef: "https://t.vault.azure.net/"},
		{Provider: "azure", SecretsXacctRef: "https://t.vault.azure.net/"},
		{Provider: "alibaba", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", SecretsXacctRef: "acs:ram::999:role/read", SecretsXacctOIDCProviderRef: "acs:ram::999:oidc-provider/ack"},
		{Provider: "alibaba", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", SecretsXacctRef: "acs:ram::999:role/read"},
		{Provider: "hetzner", SecretsXacctRef: "x"},
	}
	for i, f := range factMatrix {
		m, err := externalSecretsStoreManifest(f)
		if err != nil {
			t.Fatalf("case %d: render: %v", i, err)
		}
		rendered := strings.Contains(m, "-xacct")
		d := decisionFor(t, InfraServiceDecisions(f), xacctSvc)
		installed := d.Status == infraStatusInstalled
		if installed != rendered {
			t.Errorf("case %d (%s): decision installed=%v but the template rendered a store=%v — decision and render have diverged\nreason: %s\nmanifest:\n%s",
				i, f.Provider, installed, rendered, d.Reason, m)
		}
	}
}

// ── waf ──────────────────────────────────────────────────────────────────────────
//
// The WAF decision answers the question the switch could not: "is anything actually being
// inspected?". Every cloud's template can BUILD a web ACL behind the canvas switch, and until
// the ALB annotation landed, every one of them attached it to NOTHING — a project could carry
// the ACL, the bill and zero filtered requests with no record saying so. These cases pin the
// three outcomes apart: attached, built-but-unattached, and never built.

// awsWAFFacts is a fully-wired AWS project (DNS on, ACM cert issued) with the regional web ACL
// present — the only shape in which the annotation actually ships today.
func awsWAFFacts() *InfraFacts {
	return &InfraFacts{
		Provider:          "aws",
		DNSEnabled:        true,
		DomainName:        "example.com",
		ACMCertificateArn: "arn:aws:acm:us-east-1:123:certificate/abc",
		WAFWebACLArn:      "arn:aws:wafv2:us-east-1:123:regional/webacl/app/0c4e",
	}
}

func TestInfraServiceDecisions_WAFAttachedOnAWS(t *testing.T) {
	d := decisionFor(t, InfraServiceDecisions(awsWAFFacts()), "waf")
	if d.Status != infraStatusInstalled {
		t.Fatalf("aws waf (ACL + ingress): want installed, got %s (%s)", d.Status, d.Reason)
	}
	// The reason must carry the ARN and name the annotation — an operator reading the console
	// should be able to check the association without guessing what we did.
	if !strings.Contains(d.Reason, "arn:aws:wafv2:us-east-1:123:regional/webacl/app/0c4e") {
		t.Errorf("waf installed reason should carry the web ACL ARN, got %q", d.Reason)
	}
	if !strings.Contains(d.Reason, "wafv2-acl-arn") {
		t.Errorf("waf installed reason should name the annotation that attaches it, got %q", d.Reason)
	}
}

// The switch off ⇒ no ACL was built at all. The reason must say so and point at the switch,
// NOT at a missing ingress — those are different problems with different fixes.
func TestInfraServiceDecisions_WAFOffOnAWS(t *testing.T) {
	f := awsWAFFacts()
	f.WAFWebACLArn = ""
	d := decisionFor(t, InfraServiceDecisions(f), "waf")
	if d.Status != infraStatusSkipped {
		t.Fatalf("aws waf (switch off): want skipped, got %s (%s)", d.Status, d.Reason)
	}
	if !strings.Contains(strings.ToLower(d.Reason), "no web acl was built") {
		t.Errorf("waf skip reason should say no web ACL was built, got %q", d.Reason)
	}
}

// The dangerous middle case: the ACL exists (and bills) but no ingress carries the annotation,
// so nothing is inspected. Recording this as "installed" would be the exact lie the decision
// exists to prevent.
func TestInfraServiceDecisions_WAFBuiltButNoIngress(t *testing.T) {
	f := awsWAFFacts()
	f.ACMCertificateArn = "" // no ACM cert ⇒ installArgoCD renders no ingress at all
	d := decisionFor(t, InfraServiceDecisions(f), "waf")
	if d.Status != infraStatusSkipped {
		t.Fatalf("aws waf (ACL, no ingress): want skipped, got %s (%s)", d.Status, d.Reason)
	}
	if !strings.Contains(strings.ToLower(d.Reason), "no managed ingress") {
		t.Errorf("waf skip reason should say there is no ingress to attach to, got %q", d.Reason)
	}
}

// Every ingress gate is a conjunction, so its skip reason must name WHICH half was missing:
// "turn DNS on" and "turn the certificate on" are different fixes, and an operator told the wrong
// one goes looking in the wrong place.
//
// Run per cloud that HAS a gate, so an ingress lane adding one to argocdURLGates gets told to
// supply the same three answers rather than inheriting a single sentence covering none of them.
// The AWS certificate arm deliberately keeps the shared default, so that message is pinned too —
// it is the pre-existing behaviour and staying byte-identical is the point.
func TestArgocdURLSkipReasonNamesTheMissingHalf(t *testing.T) {
	clouds := map[string]struct {
		full           func() *InfraFacts
		dropCert       func(*InfraFacts)
		wantNoCertText string
	}{
		"aws": {
			full: func() *InfraFacts {
				return &InfraFacts{Provider: "aws", DNSEnabled: true, DomainName: "example.com",
					ACMCertificateArn: "arn:aws:acm:us-east-1:123:certificate/abc"}
			},
			dropCert:       func(f *InfraFacts) { f.ACMCertificateArn = "" },
			wantNoCertText: "no managed ingress on this cloud yet",
		},
		"gcp": {
			full: func() *InfraFacts {
				return &InfraFacts{Provider: "gcp", DNSEnabled: true, DomainName: "example.com",
					GCPManagedCertName: "alethia-cert-0c4e1a2b"}
			},
			dropCert:       func(f *InfraFacts) { f.GCPManagedCertName = "" },
			wantNoCertText: "no google-managed ssl certificate was provisioned",
		},
	}
	for cloud, spec := range clouds {
		t.Run(cloud, func(t *testing.T) {
			// Sanity: the fully-wired shape must actually be installed, or the cases below
			// would pass for the wrong reason.
			if d := decisionFor(t, InfraServiceDecisions(spec.full()), "argocd-url"); d.Status != infraStatusInstalled {
				t.Fatalf("fully-wired %s: want installed, got %s (%s)", cloud, d.Status, d.Reason)
			}
			cases := []struct {
				name   string
				mutate func(*InfraFacts)
				want   string
			}{
				{"dns off", func(f *InfraFacts) { f.DNSEnabled = false }, "dns is disabled"},
				{"no domain", func(f *InfraFacts) { f.DomainName = "" }, "no domain is configured"},
				{"no certificate", spec.dropCert, spec.wantNoCertText},
			}
			for _, c := range cases {
				t.Run(c.name, func(t *testing.T) {
					f := spec.full()
					c.mutate(f)
					d := decisionFor(t, InfraServiceDecisions(f), "argocd-url")
					if d.Status != infraStatusSkipped {
						t.Fatalf("want skipped, got %s (%s)", d.Status, d.Reason)
					}
					if !strings.Contains(strings.ToLower(d.Reason), c.want) {
						t.Errorf("skip reason should contain %q, got %q", c.want, d.Reason)
					}
				})
			}
		})
	}
}

// The WAF decision must never outrun the ingress that carries it: "installed" implies the
// argocd-url decision is installed too, on every cloud and every fact shape. They are derived
// from one another precisely so they cannot drift, and this is the assertion that says so.
func TestInfraServiceDecisions_WAFNeverOutrunsTheIngress(t *testing.T) {
	for _, p := range []string{"aws", "gcp", "azure", "alibaba", "hetzner", "digitalocean"} {
		for _, acl := range []string{"", "acl-ref"} {
			for _, cert := range []string{"", "arn:aws:acm:us-east-1:123:certificate/abc"} {
				f := &InfraFacts{Provider: p, DNSEnabled: true, DomainName: "example.com",
					ACMCertificateArn: cert, WAFWebACLArn: acl}
				decisions := InfraServiceDecisions(f)
				waf := decisionFor(t, decisions, "waf")
				url := decisionFor(t, decisions, "argocd-url")
				if waf.Status == infraStatusInstalled && url.Status != infraStatusInstalled {
					t.Errorf("%s (acl=%q cert=%q): waf reported attached with no managed ingress (argocd-url=%s)",
						p, acl, cert, url.Status)
				}
			}
		}
	}
}

// AWS and GCP export a web ACL reference. azure/alibaba each BUILD a construct (a WAF policy / a
// WAF instance) but declare no root output and have no ingress, and Hetzner sells no managed WAF
// at all — each must say which of those it is, so "we did not wire it yet" is never mistaken for
// "you left the switch off", and neither is mistaken for "this cloud cannot".
//
// GCP's reason moved with this lane. Its Cloud Armor policy is exported and attachable now, so the
// only remaining reason there is nothing to attach is an unset switch; keeping the old "no ingress
// to attach it to yet" would send the operator to fix a gap that no longer exists.
func TestInfraServiceDecisions_WAFPerCloudSkipReasons(t *testing.T) {
	cases := map[string]string{
		"gcp":     "no cloud armor policy was built",
		"azure":   "no ingress to attach it to yet",
		"alibaba": "no ingress to attach it to yet",
		"hetzner": "sells no managed waf",
	}
	for provider, want := range cases {
		t.Run(provider, func(t *testing.T) {
			// A web ACL ARN on the facts must NOT be enough on a cloud that exports none —
			// the decision is keyed on the cloud, not on a stray field value.
			f := &InfraFacts{Provider: provider, WAFWebACLArn: "arn:aws:wafv2:us-east-1:123:regional/webacl/app/0c4e"}
			d := decisionFor(t, InfraServiceDecisions(f), "waf")
			if d.Status != infraStatusSkipped {
				t.Fatalf("%s waf: want skipped, got %s (%s)", provider, d.Status, d.Reason)
			}
			if !strings.Contains(strings.ToLower(d.Reason), want) {
				t.Errorf("%s waf skip reason should contain %q, got %q", provider, want, d.Reason)
			}
		})
	}
}

// ── the per-cloud tables ─────────────────────────────────────────────────────────
//
// The point of the tables is that a cloud is an ENTRY, not another arm of an if/else. These
// pin the behaviour the four ingress lanes are about to build on: a cloud absent from a table
// is a SKIP with the shared reason (fail-closed — it never inherits AWS's claim), and the two
// decisions the lanes touch agree with each other.

func TestIngressDecision_AbsentCloudsSkipWithTheSharedReason(t *testing.T) {
	// gcp has left this list: GKE's Ingress controller is built into the managed control plane, so
	// its entry is unconditional-installed (see the positive assertion below). azure/alibaba are
	// the lanes still to land, and hetzner/digitalocean/"" are the fail-closed direction — a cloud
	// absent from the table inherits nothing.
	for _, p := range []string{"azure", "alibaba", "hetzner", "digitalocean", ""} {
		d := decisionFor(t, InfraServiceDecisions(&InfraFacts{Provider: p}), "ingress")
		if d.Status != infraStatusSkipped {
			t.Errorf("%q ingress: want skipped (no table entry), got %s (%s)", p, d.Status, d.Reason)
		}
		if d.Reason != ingressNoControllerReason {
			t.Errorf("%q ingress: want the shared no-controller reason, got %q", p, d.Reason)
		}
	}
	// Both table entries are unconditional, for opposite reasons: AWS installs the ALB controller
	// itself, GCP gets one from GKE. Neither depends on a provisioned fact, so zero-value facts
	// must still report installed.
	for _, p := range []string{"aws", "gcp"} {
		if d := decisionFor(t, InfraServiceDecisions(&InfraFacts{Provider: p}), "ingress"); d.Status != infraStatusInstalled {
			t.Errorf("%s ingress: want installed, got %s (%s)", p, d.Status, d.Reason)
		}
	}
	// GCP's reason must say the controller is the CLOUD's, not ours. An operator reading
	// "installed" needs to know there is no Alethia-managed Application to look at.
	gcp := decisionFor(t, InfraServiceDecisions(&InfraFacts{Provider: "gcp"}), "ingress")
	if !strings.Contains(gcp.Reason, "built-in") || !strings.Contains(gcp.Reason, "gce") {
		t.Errorf("gcp ingress reason must name the built-in `gce` controller, got %q", gcp.Reason)
	}
}

// A cloud in ingressControllers must reach argocdURLGates too, or it ships a controller nobody
// can get a URL out of. Today AWS is the only member of both; the assertion is here so the
// FIRST lane that adds a controller without a URL predicate is told, rather than shipping an
// ingress whose ArgoCD URL silently stays "port-forward".
func TestIngressAndArgocdURLTablesCoverTheSameClouds(t *testing.T) {
	for provider := range ingressControllers {
		if _, ok := argocdURLGates[provider]; !ok {
			t.Errorf("provider %q has an ingress controller but no argocdURLGates entry — a managed ingress with no managed URL. Add its predicate (what makes the ArgoCD URL reachable on that cloud) or document the exclusion.", provider)
		}
	}
	for provider := range argocdURLGates {
		if _, ok := ingressControllers[provider]; !ok {
			t.Errorf("provider %q claims a managed ArgoCD URL but wires no ingress controller — the URL would resolve nowhere.", provider)
		}
	}
}

// perProviderDecision is the shared evaluator both tables run through; these are its edges.
func TestPerProviderDecision_TableSemantics(t *testing.T) {
	const def = "default skip"
	table := map[string]providerDecision{
		"unconditional": {installedReason: "in"},
		"conditional": {
			installed:       func(f *InfraFacts) bool { return f.ClusterName != "" },
			installedReason: "in",
			skippedReason:   func(*InfraFacts) string { return "specific skip" },
		},
		"conditional without its own skip reason": {
			installed:       func(f *InfraFacts) bool { return f.ClusterName != "" },
			installedReason: "in",
		},
		// A skippedReason that declines to speak for THIS shape of miss. The "" return is how
		// a per-cloud reason function covers only the arms it has something specific to say
		// about and leaves the rest to the shared default — awsArgocdURLSkipReason does exactly
		// this for the missing-certificate case, to stay byte-identical to the pre-gate reason.
		"conditional whose skip reason returns empty": {
			installed:       func(f *InfraFacts) bool { return f.ClusterName != "" },
			installedReason: "in",
			skippedReason:   func(*InfraFacts) string { return "" },
		},
	}
	cases := []struct {
		provider, cluster, wantStatus, wantReason string
	}{
		{"unconditional", "", infraStatusInstalled, "in"},
		{"conditional", "c", infraStatusInstalled, "in"},
		{"conditional", "", infraStatusSkipped, "specific skip"},
		{"conditional without its own skip reason", "", infraStatusSkipped, def},
		{"conditional whose skip reason returns empty", "", infraStatusSkipped, def},
		{"absent from the table", "c", infraStatusSkipped, def},
	}
	for _, c := range cases {
		d := perProviderDecision("svc", &InfraFacts{Provider: c.provider, ClusterName: c.cluster}, table, def)
		if d.Service != "svc" || d.Status != c.wantStatus || d.Reason != c.wantReason {
			t.Errorf("perProviderDecision(%q, cluster=%q) = %+v, want status %s reason %q",
				c.provider, c.cluster, d, c.wantStatus, c.wantReason)
		}
	}
}
