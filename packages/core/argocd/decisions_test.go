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
	if len(decisions) != 5 {
		t.Fatalf("expected 5 decisions (one per service), got %d", len(decisions))
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
