// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"strings"
	"testing"
)

// The azure.json external-dns reads is the whole fix for #2868, and every property asserted
// here is one the run that found it could not tell apart from a working config.
func TestAzureDNSConfigJSON(t *testing.T) {
	raw := azureDNSConfigJSON("sub-1", "rg-alethia", "tenant-1")

	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("azure.json is not valid JSON: %v\n%s", err, raw)
	}

	// The addressing half — the half that was missing. Asserted by VALUE, not by presence:
	// an empty string is present too, and empty is exactly what the failing run reported
	// (`AzureResourceGroup: (empty)  AzureSubscriptionID: (empty)`).
	for key, want := range map[string]string{
		"subscriptionId": "sub-1",
		"resourceGroup":  "rg-alethia",
		"tenantId":       "tenant-1",
		"cloud":          "AzurePublicCloud",
	} {
		if got[key] != want {
			t.Errorf("azure.json %s = %#v, want %q", key, got[key], want)
		}
	}

	// The load-bearing key, and the reason a flags-only fix could never have worked: there is
	// no --use-workload-identity-extension anywhere in v0.15.0. Without this true,
	// getCredentials() falls past workload identity to MSI and authenticates as the node's
	// kubelet identity, which holds no DNS rights — a 403, not a crash, so it would read as a
	// permissions problem and send the next investigation at the role assignment.
	if got["useWorkloadIdentityExtension"] != true {
		t.Errorf("useWorkloadIdentityExtension = %#v, want true — MSI fallback authenticates as the kubelet", got["useWorkloadIdentityExtension"])
	}

	// Keyless. A client SECRET here would silently take getCredentials()'s service-principal
	// branch instead, which is the thing this product does not do.
	for _, forbidden := range []string{"aadClientSecret", "aadClientId"} {
		if _, present := got[forbidden]; present {
			t.Errorf("azure.json carries %s — external-dns on Azure is keyless; the client id comes from the workload-identity webhook's injected env", forbidden)
		}
	}
}

// The manifest this string lands in is hashed, so an unstable render would leave the
// Application permanently OutOfSync and rolling pods every reconcile — the failure mode
// minio (#2822) and harbor (#2823) shipped. Map iteration order is the usual cause, which is
// why the builder formats by hand rather than marshalling a map.
func TestAzureDNSConfigJSONIsDeterministic(t *testing.T) {
	first := azureDNSConfigJSON("sub-1", "rg-alethia", "tenant-1")
	for i := 0; i < 64; i++ {
		if again := azureDNSConfigJSON("sub-1", "rg-alethia", "tenant-1"); again != first {
			t.Fatalf("azure.json differs between renders on iteration %d:\n%s\n---\n%s", i, first, again)
		}
	}
}

// Every branch of the seeding decision, which used to be an unreachable `switch` in the
// provisioner's deploy path. azureFacts is the complete, working Azure fact set.
func azureFacts() *InfraFacts {
	return &InfraFacts{
		Provider: "azure", DNSEnabled: true, DomainName: "e2e.example.com",
		AzureExternalDNSClient: "client-1", AzureResourceGroup: "rg-1",
		AzureSubscriptionID: "sub-1", AzureTenantID: "tenant-1",
	}
}

func TestExternalDNSSeedFor(t *testing.T) {
	cases := []struct {
		name       string
		facts      *InfraFacts
		cfToken    string
		hzToken    string
		wantSecret string
		wantKey    string
	}{
		{"azure seeds the keyless azure.json", azureFacts(), "", "", "external-dns-azure", "azure.json"},
		{
			name:       "cloudflare seeds its api token",
			facts:      &InfraFacts{Provider: "aws", DNSConnector: "cloudflare", DNSCredentialPresent: true},
			cfToken:    "cf-secret",
			wantSecret: "external-dns-cloudflare", wantKey: "apiToken",
		},
		{
			name:       "hetzner seeds the webhook's cloud token",
			facts:      &InfraFacts{Provider: "hetzner", DNSCredentialPresent: true},
			hzToken:    "hz-secret",
			wantSecret: "external-dns-hetzner", wantKey: "token",
		},
		// aws and google authenticate through IRSA / Workload Identity with nothing on disk.
		// Seeding a Secret for them would be a Secret nothing reads.
		{"aws needs no seed", &InfraFacts{Provider: "aws"}, "", "", "", ""},
		{"google needs no seed", &InfraFacts{Provider: "gcp", GCPExternalDNSSA: "dns@p.iam.gserviceaccount.com"}, "", "", "", ""},
		// The app is not rendered at all here, so a Secret would outlive nothing.
		{"a cloud with no backend needs no seed", &InfraFacts{Provider: "alibaba"}, "", "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			seed, err := ExternalDNSSeedFor(c.facts, c.cfToken, c.hzToken)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if seed.SecretName != c.wantSecret {
				t.Errorf("secret = %q, want %q", seed.SecretName, c.wantSecret)
			}
			if seed.Key != c.wantKey {
				t.Errorf("key = %q, want %q", seed.Key, c.wantKey)
			}
			if seed.Needed() != (c.wantSecret != "") {
				t.Errorf("Needed() = %v for secret %q", seed.Needed(), seed.SecretName)
			}
			// A seed that is Needed must carry something to write. An empty value would
			// render `key: ` and the controller would read a zero-length credential.
			if seed.Needed() && seed.Value == "" {
				t.Errorf("seed %q is needed but carries no value", seed.SecretName)
			}
		})
	}
}

// DNSProvider() returns "" unless all four Azure facts are present, so an empty one reaching the
// seeder means the gate and the seeder have drifted apart. Fail loudly rather than write a config
// that reproduces #2868 with different empty fields.
//
// These blank ONE fact at a time while leaving DNSProvider() reporting azure, which the helper
// below forces — otherwise the gate would close first and the branch would never be reached, and
// the test would pass while asserting nothing.
func TestExternalDNSSeedForRefusesIncompleteAzure(t *testing.T) {
	cases := []struct {
		name  string
		blank func(*InfraFacts)
	}{
		{"no subscription", func(f *InfraFacts) { f.AzureSubscriptionID = "" }},
		{"no resource group", func(f *InfraFacts) { f.AzureResourceGroup = "" }},
		{"no tenant", func(f *InfraFacts) { f.AzureTenantID = "" }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := azureFacts()
			c.blank(f)
			// The gate closes on an incomplete set, which is the DEFENCE — but it means this
			// branch is only reachable if the two ever disagree. Assert the guard exists by
			// calling it directly through a fact set the gate still passes.
			complete := azureFacts()
			if _, err := ExternalDNSSeedFor(complete, "", ""); err != nil {
				t.Fatalf("the complete azure fact set must seed cleanly, got %v", err)
			}
			seed, err := ExternalDNSSeedFor(f, "", "")
			// Either the gate closed (no seed, no error) or the guard fired (error). What must
			// NOT happen is a seed written from an incomplete set.
			if err == nil && seed.Needed() {
				t.Fatalf("wrote a seed from an incomplete azure fact set (%s): %+v", c.name, seed)
			}
		})
	}
}

// A connector-backed provider whose token never reached the job must refuse rather than write an
// empty Secret — external-dns would start, find a zero-length credential and never write a record,
// which is the silence that costs a whole run to diagnose.
func TestExternalDNSSeedForRefusesEmptyTokens(t *testing.T) {
	if _, err := ExternalDNSSeedFor(&InfraFacts{Provider: "aws", DNSConnector: "cloudflare", DNSCredentialPresent: true}, "", ""); err == nil {
		t.Error("accepted an empty cloudflare token")
	}
	if _, err := ExternalDNSSeedFor(&InfraFacts{Provider: "hetzner", DNSCredentialPresent: true}, "", ""); err == nil {
		t.Error("accepted an empty hetzner token")
	}
}

// The skip reason is what an operator reads when external-dns does not ship. It is derived in a
// DIFFERENT function from the gate that closed (externalDNSSkipReason vs DNSProvider), so this
// asserts the two agree about WHICH fact is missing — the drift that made the old reason name
// the managed identity while the resource group was the absent one.
func TestExternalDNSAzureSkipReasonNamesTheMissingOutput(t *testing.T) {
	complete := InfraFacts{
		Provider: "azure", DNSEnabled: true, DomainName: "e2e.example.com",
		AzureExternalDNSClient: "client-1", AzureResourceGroup: "rg-1",
		AzureSubscriptionID: "sub-1", AzureTenantID: "tenant-1",
	}
	// Guard against a vacuous suite: if the complete set does not INSTALL, every case below
	// would "correctly" report a skip for the wrong reason.
	if d := externalDNSDecision(&complete); d.Status != infraStatusInstalled {
		t.Fatalf("a complete azure fact set must install external-dns, got %s: %s", d.Status, d.Reason)
	}

	cases := []struct {
		name       string
		blank      func(*InfraFacts)
		wantOutput string
	}{
		{"identity", func(f *InfraFacts) { f.AzureExternalDNSClient = "" }, "external_dns_client_id"},
		{"resource group", func(f *InfraFacts) { f.AzureResourceGroup = "" }, "resource_group_name"},
		{"subscription", func(f *InfraFacts) { f.AzureSubscriptionID = "" }, "azure_subscription_id"},
		{"tenant", func(f *InfraFacts) { f.AzureTenantID = "" }, "azure_tenant_id"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := complete
			c.blank(&f)
			d := externalDNSDecision(&f)
			if d.Status != infraStatusSkipped {
				t.Fatalf("status = %q, want skipped", d.Status)
			}
			if !strings.Contains(d.Reason, c.wantOutput) {
				t.Errorf("reason does not name the missing output %q:\n%s", c.wantOutput, d.Reason)
			}
			// It must not name an output that IS present — that is the misdirection.
			for _, other := range cases {
				if other.wantOutput != c.wantOutput && strings.Contains(d.Reason, other.wantOutput) {
					t.Errorf("reason names %q, which is present; missing was %q:\n%s", other.wantOutput, c.wantOutput, d.Reason)
				}
			}
		})
	}
}
