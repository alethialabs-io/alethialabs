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

// TestExternalSecretsStoreManifest_SaaS covers the pluggable SaaS ClusterSecretStore (Vault / OpenBao /
// Doppler / generic Vault-compatible): it renders as a SEPARATE document (leading `---`), is
// CLOUD-AGNOSTIC (renders even on Hetzner, which has no native store), and authenticates via a seeded
// token Secret (auth.secretRef), not workload identity.
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
				CredSecret: "secretstore-vault-creds", CredKey: "token", Namespace: "external-secrets-operator",
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
					CredSecret: "secretstore-doppler-creds", CredKey: "dopplerToken", Namespace: "external-secrets-operator",
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
					CredSecret: "secretstore-generic-creds", CredKey: "token", Namespace: "external-secrets-operator",
					Server: "https://openbao.internal:8200", Path: "kv", Version: "v2",
				}},
			"secretstore-generic",
			[]string{"vault:", `server: "https://openbao.internal:8200"`, `path: "kv"`, "name: secretstore-generic-creds"},
			nil},
		{"doppler omits absent project/config",
			&InfraFacts{Provider: "hetzner", SecretsSaaS: &categories.SecretsSaaSStore{
				Slug: "doppler", Kind: "doppler", StoreName: "secretstore-doppler",
				CredSecret: "secretstore-doppler-creds", CredKey: "dopplerToken", Namespace: "external-secrets-operator",
			}},
			"secretstore-doppler",
			[]string{"doppler:", "dopplerToken:"},
			[]string{"project:", "config:"}},
		{"no SaaS store selected", &InfraFacts{Provider: "hetzner"}, "", nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := externalSecretsStoreManifest(c.facts)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if c.wantStore == "" {
				if strings.Contains(m, "secretstore-vault") || strings.Contains(m, "secretstore-doppler") || strings.Contains(m, "secretstore-generic") {
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
	m := secretsSaaSCredentialManifest("external-secrets-operator", "secretstore-vault-creds", "token", "v4ult-t0ken")
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

// TestEnsureSecretsStoreCredentialRefusesEmptyToken is the fail-closed guard: an absent token means
// the store's render gate skipped it, so writing an empty credential Secret is refused.
func TestEnsureSecretsStoreCredentialRefusesEmptyToken(t *testing.T) {
	if err := EnsureSecretsStoreCredential("external-secrets-operator", "secretstore-vault-creds", "token", "", io.Discard, io.Discard); err == nil {
		t.Fatalf("expected an error for an empty token")
	}
}
