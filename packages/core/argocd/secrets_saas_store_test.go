// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
)

// tokenCred is the single-key credential set vault / generic / doppler seed. Infisical is the one
// store with a second key, so spelling this once keeps the single-token cases readable.
func tokenCred(key string) []categories.SecretsSaaSCredRef {
	return []categories.SecretsSaaSCredRef{
		{Role: categories.SaaSCredToken, Key: key, CredentialField: "token"},
	}
}

// TestExternalSecretsStoreManifest_SaaS covers the pluggable SaaS ClusterSecretStore (Vault / OpenBao /
// Doppler / generic Vault-compatible / Infisical): it renders as a SEPARATE document (leading `---`), is
// CLOUD-AGNOSTIC (renders even on Hetzner, which has no native store), and authenticates via a seeded
// credential Secret (auth.secretRef), not workload identity.
func TestExternalSecretsStoreManifest_SaaS(t *testing.T) {
	cases := []struct {
		name        string
		facts       *InfraFacts
		wantStore   string // "" ⇒ expect NO SaaS store
		wantContain []string
		notContain  []string
	}{
		{"vault on hetzner (cloud-agnostic)",
			&InfraFacts{Provider: "hetzner", SecretsSaaS: &categories.SecretsSaaSStore{
				Slug: "vault", Kind: "vault", StoreName: "secretstore-vault",
				CredSecret: "secretstore-vault-creds", Creds: tokenCred("token"), Namespace: "external-secrets-operator",
				Server: "https://vault.example.com:8200", Path: "secret", Version: "v2",
			}},
			"secretstore-vault",
			[]string{"provider:", "vault:", `server: "https://vault.example.com:8200"`, `path: "secret"`, "version: v2",
				"tokenSecretRef:", "name: secretstore-vault-creds", "key: token", "namespace: external-secrets-operator"},
			nil},
		{"doppler with project/config",
			&InfraFacts{Provider: "aws", Region: "us-east-1", IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
				SecretsSaaS: &categories.SecretsSaaSStore{
					Slug: "doppler", Kind: "doppler", StoreName: "secretstore-doppler",
					CredSecret: "secretstore-doppler-creds", Creds: tokenCred("dopplerToken"), Namespace: "external-secrets-operator",
					Project: "proj", Config: "prod",
				}},
			"secretstore-doppler",
			[]string{"doppler:", `project: "proj"`, `config: "prod"`, "secretRef:", "dopplerToken:",
				"name: secretstore-doppler-creds", "key: dopplerToken"},
			nil},
		{"generic reuses provider.vault",
			&InfraFacts{Provider: "gcp", GCPExternalSecretsSA: "eso@p.iam.gserviceaccount.com", GCPProjectID: "p",
				SecretsSaaS: &categories.SecretsSaaSStore{
					Slug: "generic", Kind: "vault", StoreName: "secretstore-generic",
					CredSecret: "secretstore-generic-creds", Creds: tokenCred("token"), Namespace: "external-secrets-operator",
					Server: "https://openbao.internal:8200", Path: "kv", Version: "v2",
				}},
			"secretstore-generic",
			[]string{"vault:", `server: "https://openbao.internal:8200"`, `path: "kv"`, "name: secretstore-generic-creds"},
			nil},
		{"doppler omits absent project/config",
			&InfraFacts{Provider: "hetzner", SecretsSaaS: &categories.SecretsSaaSStore{
				Slug: "doppler", Kind: "doppler", StoreName: "secretstore-doppler",
				CredSecret: "secretstore-doppler-creds", Creds: tokenCred("dopplerToken"), Namespace: "external-secrets-operator",
			}},
			"secretstore-doppler",
			[]string{"doppler:", "dopplerToken:"},
			[]string{"project:", "config:"}},
		// Infisical is the only store whose auth needs TWO SecretKeySelectors, and the only one whose
		// scope is addressed by a SLUG rather than the workspace id the tofu write path uses. Both are
		// pinned here: a store rendered with the id in projectSlug resolves nothing, silently.
		{"infisical renders both universal-auth refs and a slug scope",
			&InfraFacts{Provider: "hetzner", SecretsSaaS: &categories.SecretsSaaSStore{
				Slug: "infisical", Kind: "infisical", StoreName: "secretstore-infisical",
				CredSecret: "secretstore-infisical-creds", Namespace: "external-secrets-operator",
				Creds: []categories.SecretsSaaSCredRef{
					{Role: categories.SaaSCredClientID, Key: "clientId", CredentialField: "client_id"},
					{Role: categories.SaaSCredClientSecret, Key: "clientSecret", CredentialField: "client_secret"},
				},
				HostAPI: "https://app.infisical.com", ProjectSlug: "payments-fujo",
				EnvironmentSlug: "prod", SecretsPath: "/",
			}},
			"secretstore-infisical",
			[]string{"infisical:", "universalAuthCredentials:", "clientId:", "clientSecret:",
				"name: secretstore-infisical-creds", "key: clientId", "key: clientSecret",
				"secretsScope:", `projectSlug: "payments-fujo"`, `environmentSlug: "prod"`,
				`secretsPath: "/"`, `hostAPI: "https://app.infisical.com"`},
			nil},
		{"no SaaS store selected", &InfraFacts{Provider: "hetzner"}, "", nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := externalSecretsStoreManifest(c.facts)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if c.wantStore == "" {
				if strings.Contains(m, "secretstore-vault") || strings.Contains(m, "secretstore-doppler") ||
					strings.Contains(m, "secretstore-generic") || strings.Contains(m, "secretstore-infisical") {
					t.Fatalf("expected NO SaaS store, got:\n%s", m)
				}
				return
			}
			if !strings.Contains(m, "name: "+c.wantStore) {
				t.Fatalf("expected a %s ClusterSecretStore, got:\n%s", c.wantStore, m)
			}
			// The SaaS store is a separate document — the separator must be present.
			if !strings.Contains(m, "---") {
				t.Errorf("expected a doc separator before the %s store:\n%s", c.wantStore, m)
			}
			for _, want := range c.wantContain {
				if !strings.Contains(m, want) {
					t.Errorf("%s must contain %q:\n%s", c.wantStore, want, m)
				}
			}
			for _, no := range c.notContain {
				if strings.Contains(m, no) {
					t.Errorf("%s must NOT contain %q:\n%s", c.wantStore, no, m)
				}
			}
		})
	}
}

// TestSecretsSaaSCredentialManifest asserts the seeder writes a namespaced, base64-encoded token
// Secret and never leaks the raw token.
func TestSecretsSaaSCredentialManifest(t *testing.T) {
	m := secretsSaaSCredentialManifest("external-secrets-operator", "secretstore-vault-creds",
		[]SecretsStoreCredential{{Key: "token", Value: "v4ult-t0ken"}})
	for _, want := range []string{
		"kind: Namespace", "name: external-secrets-operator",
		"kind: Secret", "name: secretstore-vault-creds", "namespace: external-secrets-operator",
		"token: " + base64.StdEncoding.EncodeToString([]byte("v4ult-t0ken")),
	} {
		if !strings.Contains(m, want) {
			t.Errorf("manifest must contain %q:\n%s", want, m)
		}
	}
	if strings.Contains(m, "v4ult-t0ken") {
		t.Errorf("raw token must not appear unencoded:\n%s", m)
	}
}

// TestSecretsSaaSCredentialManifestMultiKey covers infisical's two-key Universal Auth: BOTH values
// land, each base64-encoded, in the caller's order, and neither appears in the clear.
func TestSecretsSaaSCredentialManifestMultiKey(t *testing.T) {
	m := secretsSaaSCredentialManifest("external-secrets-operator", "secretstore-infisical-creds",
		[]SecretsStoreCredential{
			{Key: "clientId", Value: "cl13nt-1d"},
			{Key: "clientSecret", Value: "cl13nt-s3cret"},
		})
	for _, want := range []string{
		"clientId: " + base64.StdEncoding.EncodeToString([]byte("cl13nt-1d")),
		"clientSecret: " + base64.StdEncoding.EncodeToString([]byte("cl13nt-s3cret")),
	} {
		if !strings.Contains(m, want) {
			t.Errorf("manifest must contain %q:\n%s", want, m)
		}
	}
	for _, raw := range []string{"cl13nt-1d", "cl13nt-s3cret"} {
		if strings.Contains(m, raw) {
			t.Errorf("raw credential %q must not appear unencoded:\n%s", raw, m)
		}
	}
	if i, j := strings.Index(m, "clientId:"), strings.Index(m, "clientSecret:"); i > j {
		t.Errorf("keys must render in the caller's order, got:\n%s", m)
	}
}

// TestEnsureSecretsStoreCredentialRefusesEmpty is the fail-closed guard: an absent credential means
// the store's render gate skipped it, so writing an empty credential Secret is refused. EVERY key is
// checked, not just the first — a half-written two-key Secret would authenticate a store that can
// never authenticate, which is the failure mode a single-key check would wave through.
func TestEnsureSecretsStoreCredentialRefusesEmpty(t *testing.T) {
	cases := []struct {
		name string
		data []SecretsStoreCredential
	}{
		{"no keys at all", nil},
		{"the only key is empty", []SecretsStoreCredential{{Key: "token", Value: ""}}},
		{"the FIRST of two is empty", []SecretsStoreCredential{
			{Key: "clientId", Value: ""}, {Key: "clientSecret", Value: "s"}}},
		{"the SECOND of two is empty", []SecretsStoreCredential{
			{Key: "clientId", Value: "i"}, {Key: "clientSecret", Value: ""}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := EnsureSecretsStoreCredential("external-secrets-operator", "secretstore-x-creds",
				c.data, io.Discard, io.Discard); err == nil {
				t.Fatalf("expected an error for %s", c.name)
			}
		})
	}
}
