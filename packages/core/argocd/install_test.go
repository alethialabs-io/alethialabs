// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"io"
	"strings"
	"testing"
)

func TestIsOperatorNotReady(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   bool
	}{
		{"crd not registered", `error: resource mapping not found for name: "secretstore-azure": no matches for kind "ClusterSecretStore" in version "external-secrets.io/v1beta1"`, true},
		{"no matches for kind", `unable to recognize "x.yaml": no matches for kind "SecretStore"`, true},
		{"webhook no endpoints", `Error from server (InternalError): failed calling webhook "validate.clustersecretstore.external-secrets.io": failed to call webhook: Post "https://...": no endpoints available for service "external-secrets-operator-webhook"`, true},
		{"real auth failure not retried", `error: unable to apply: forbidden: user cannot patch`, false},
		{"validation error not retried", `error validating data: unknown field "spec.bogus"`, false},
		{"empty output", "", false},
	}
	for _, c := range cases {
		if got := isOperatorNotReady(c.output); got != c.want {
			t.Errorf("%s: isOperatorNotReady=%v, want %v", c.name, got, c.want)
		}
	}
}

func TestExternalDNSSecretManifest(t *testing.T) {
	m := externalDNSSecretManifest("external-dns-cloudflare", "apiToken", "s3cret")
	if !strings.Contains(m, "kind: Namespace") || !strings.Contains(m, "name: external-dns") {
		t.Errorf("manifest must create the external-dns namespace first:\n%s", m)
	}
	if !strings.Contains(m, "name: external-dns-cloudflare") {
		t.Errorf("manifest must name the secret:\n%s", m)
	}
	want := "apiToken: " + base64.StdEncoding.EncodeToString([]byte("s3cret"))
	if !strings.Contains(m, want) {
		t.Errorf("manifest must carry the base64 token under the given key:\n%s", m)
	}
	if strings.Contains(m, "s3cret") {
		t.Errorf("raw token must not appear unencoded:\n%s", m)
	}
}

func TestEnsureExternalDNSSecretRefusesEmptyToken(t *testing.T) {
	// Fail-closed: an empty token means the render gate should have skipped the app —
	// writing an empty secret would just move the failure into the cluster.
	if err := EnsureExternalDNSSecret("external-dns-hetzner", "token", "", io.Discard, io.Discard); err == nil {
		t.Fatalf("expected an error for an empty token")
	}
}

func TestExternalSecretsStoreManifest(t *testing.T) {
	cases := []struct {
		name        string
		facts       *InfraFacts
		wantStore   string // "" ⇒ expect NO store (fail-closed / no cloud secret manager)
		wantContain []string
	}{
		{"aws with IRSA", &InfraFacts{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso"},
			"secretstore-aws", []string{"service: SecretsManager", "region: us-east-1", "name: external-secrets-operator-sa"}},
		{"gcp with GSA", &InfraFacts{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com", GCPProjectID: "proj-1"},
			"secretstore-gcp", []string{"gcpsm:", "projectID: proj-1"}},
		{"azure with client + vault", &InfraFacts{Provider: "azure", AzureExternalSecretsClient: "cid", AzureKeyVaultURI: "https://kv.vault.azure.net/"},
			"secretstore-azure", []string{"azurekv:", "authType: WorkloadIdentity", "vaultUrl: https://kv.vault.azure.net/"}},
		{"alibaba with role", &InfraFacts{Provider: "alibaba", Region: "eu-central-1", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", AlibabaOIDCProviderArn: "acs:ram::1:oidc-provider/ack"},
			"secretstore-alibaba", []string{"alibaba:", "regionID: eu-central-1", "rrsa:", "roleArn: acs:ram::1:role/eso"}},
		{"hetzner has no cloud store", &InfraFacts{Provider: "hetzner", Region: "nbg1"}, "", nil},
		{"aws without the IRSA fact is fail-closed empty", &InfraFacts{Provider: "aws", Region: "us-east-1"}, "", nil},
		{"azure missing the vault URI is empty", &InfraFacts{Provider: "azure", AzureExternalSecretsClient: "cid"}, "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := externalSecretsStoreManifest(c.facts)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if c.wantStore == "" {
				if m != "" {
					t.Fatalf("expected NO store, got:\n%s", m)
				}
				return
			}
			if !strings.Contains(m, "kind: ClusterSecretStore") || !strings.Contains(m, "name: "+c.wantStore) {
				t.Fatalf("expected a %s ClusterSecretStore, got:\n%s", c.wantStore, m)
			}
			for _, want := range c.wantContain {
				if !strings.Contains(m, want) {
					t.Errorf("store must contain %q:\n%s", want, m)
				}
			}
			// Exactly one cloud's block renders — never a leaked doc separator from a sibling.
			if strings.Contains(m, "---") {
				t.Errorf("a single store must not contain a doc separator:\n%s", m)
			}
		})
	}
}

// TestExternalSecretsStoreManifest_Xacct covers the ADDITIONAL cross-account (*-xacct) ClusterSecretStore:
// it renders as a SECOND document (with a `---` separator) alongside the native store, and only when BOTH
// the cluster's own external-secrets identity fact AND the cross-account target are present (fail-closed).
func TestExternalSecretsStoreManifest_Xacct(t *testing.T) {
	cases := []struct {
		name        string
		facts       *InfraFacts
		wantStore   string // the -xacct store expected, "" ⇒ none (fail-closed)
		wantContain []string
	}{
		{"aws xacct assumes target role",
			&InfraFacts{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
				SecretsXacctRef: "arn:aws:iam::999:role/read", SecretsXacctRegion: "eu-west-1"},
			"secretstore-aws-xacct", []string{"role: arn:aws:iam::999:role/read", "region: eu-west-1", "service: SecretsManager"}},
		// An sts:ExternalId condition on the target trust policy must reach the store or STS rejects every
		// assume — the dangling-control bug (the bootstrap module offered external_id while nothing carried
		// it through to ESO). Absent id ⇒ field omitted, asserted separately below.
		{"aws xacct forwards the external id when the trust policy requires one",
			&InfraFacts{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
				SecretsXacctRef: "arn:aws:iam::999:role/read", SecretsXacctRegion: "eu-west-1", SecretsXacctExternalID: "acme-7f3c"},
			"secretstore-aws-xacct", []string{"role: arn:aws:iam::999:role/read", "externalID: acme-7f3c"}},
		{"gcp xacct reads target project",
			&InfraFacts{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com", GCPProjectID: "proj-1",
				SecretsXacctProjectID: "secrets-project-b"},
			"secretstore-gcp-xacct", []string{"gcpsm:", "projectID: secrets-project-b"}},
		{"azure xacct reads target vault",
			&InfraFacts{Provider: "azure", AzureExternalSecretsClient: "cid", AzureKeyVaultURI: "https://kv.vault.azure.net/",
				SecretsXacctRef: "https://target.vault.azure.net/"},
			"secretstore-azure-xacct", []string{"authType: WorkloadIdentity", "vaultUrl: https://target.vault.azure.net/"}},
		{"alibaba xacct via target OIDC provider",
			&InfraFacts{Provider: "alibaba", Region: "cn-hangzhou", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", AlibabaOIDCProviderArn: "acs:ram::1:oidc-provider/ack",
				SecretsXacctRef: "acs:ram::999:role/read", SecretsXacctOIDCProviderRef: "acs:ram::999:oidc-provider/ack", SecretsXacctRegion: "cn-hangzhou"},
			"secretstore-alibaba-xacct", []string{"roleArn: acs:ram::999:role/read", "oidcProviderArn: acs:ram::999:oidc-provider/ack"}},
		// Fail-closed: a cross-account target selected but the cluster's own identity fact is absent ⇒
		// NEITHER store renders (nothing to authenticate the read).
		{"aws xacct without IRSA is fail-closed empty",
			&InfraFacts{Provider: "aws", Region: "us-east-1", SecretsXacctRef: "arn:aws:iam::999:role/read"}, "", nil},
		// Fail-closed: alibaba xacct missing the target OIDC provider ⇒ no xacct store.
		{"alibaba xacct without target OIDC provider omits the xacct store",
			&InfraFacts{Provider: "alibaba", Region: "cn-hangzhou", AlibabaExternalSecretsRoleArn: "acs:ram::1:role/eso", AlibabaOIDCProviderArn: "acs:ram::1:oidc-provider/ack",
				SecretsXacctRef: "acs:ram::999:role/read"}, "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := externalSecretsStoreManifest(c.facts)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if c.wantStore == "" {
				if strings.Contains(m, "-xacct") {
					t.Fatalf("expected NO -xacct store, got:\n%s", m)
				}
				return
			}
			if !strings.Contains(m, "name: "+c.wantStore) {
				t.Fatalf("expected a %s ClusterSecretStore, got:\n%s", c.wantStore, m)
			}
			// The xacct store is a SECOND document alongside the native one — the separator must be present.
			if !strings.Contains(m, "---") {
				t.Errorf("expected a doc separator between the native and %s stores:\n%s", c.wantStore, m)
			}
			for _, want := range c.wantContain {
				if !strings.Contains(m, want) {
					t.Errorf("%s must contain %q:\n%s", c.wantStore, want, m)
				}
			}
		})
	}
}

// The external id is OPTIONAL: a target role whose trust policy has NO sts:ExternalId condition is the
// common case, and sending one anyway would make STS reject the assume. So the field must be absent from
// the rendered store — not empty-valued — when the connector doesn't set it.
func TestExternalSecretsStoreManifest_XacctOmitsAbsentExternalID(t *testing.T) {
	m, err := externalSecretsStoreManifest(&InfraFacts{
		Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
		SecretsXacctRef: "arn:aws:iam::999:role/read", SecretsXacctRegion: "eu-west-1",
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(m, "secretstore-aws-xacct") {
		t.Fatalf("expected the xacct store to render:\n%s", m)
	}
	if strings.Contains(m, "externalID") {
		t.Fatalf("externalID must be omitted when unset, got:\n%s", m)
	}
}
