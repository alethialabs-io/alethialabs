// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// saasSecretProject wires a project selecting one credential-based SaaS secrets store, with its
// connection credentials attached (as they are at claim time) and its provider_config.
func saasSecretProject(slug string, creds, pc map[string]any) *types.ProjectConfig {
	credStr := map[string]string{}
	for k, v := range creds {
		credStr[k] = v.(string)
	}
	return &types.ProjectConfig{
		Secrets: []types.ProjectSecretConfig{
			{Name: "app-secret", Provider: slug, ProviderConfig: pc},
		},
		ConnectorCredentials: []types.ConnectorCredential{
			{Category: "secrets", Slug: slug, Credentials: credStr},
		},
	}
}

func TestIsSaaSSecretStoreClassification(t *testing.T) {
	// Runtime-read first-class stores on the pinned ESO chart (infisical joined them with the 0.9.20
	// pin — its provider is absent from 0.9.12's CRD bundle).
	for _, slug := range []string{"vault", "doppler", "generic", "infisical"} {
		if !IsSaaSSecretStore(slug) {
			t.Errorf("%s should be a SaaS secret store", slug)
		}
	}
	// The remaining documented runtime-read exclusion (1Password is Connect-server-only, which a bare
	// Service-Account token cannot satisfy) and the cross-account keyless managers must NOT be SaaS
	// runtime-read stores.
	for _, slug := range []string{"onepassword", "aws-sm-xacct", "native", ""} {
		if IsSaaSSecretStore(slug) {
			t.Errorf("%s must NOT be a SaaS secret store", slug)
		}
	}
}

func TestDominantSecretsSaaSStore(t *testing.T) {
	t.Run("vault", func(t *testing.T) {
		vc := saasSecretProject("vault",
			map[string]any{"address": "https://vault.example.com:8200", "token": "v4ult"},
			map[string]any{"mount_path": "kv", "kv_version": "2"})
		s, err := DominantSecretsSaaSStore(vc)
		if err != nil || s == nil {
			t.Fatalf("vault store: s=%+v err=%v", s, err)
		}
		if s.Slug != "vault" || s.Kind != "vault" || s.StoreName != "secretstore-vault" ||
			s.CredSecret != "secretstore-vault-creds" || s.CredKey("token") != "token" ||
			s.Namespace != "external-secrets-operator" ||
			s.Server != "https://vault.example.com:8200" || s.Path != "kv" || s.Version != "v2" {
			t.Fatalf("vault descriptor wrong: %+v", *s)
		}
	})

	t.Run("doppler", func(t *testing.T) {
		vc := saasSecretProject("doppler",
			map[string]any{"token": "dp.st.xxx"},
			map[string]any{"project": "acme", "config": "prd"})
		s, err := DominantSecretsSaaSStore(vc)
		if err != nil || s == nil {
			t.Fatalf("doppler store: s=%+v err=%v", s, err)
		}
		if s.Kind != "doppler" || s.StoreName != "secretstore-doppler" || s.CredKey("token") != "dopplerToken" ||
			s.Project != "acme" || s.Config != "prd" {
			t.Fatalf("doppler descriptor wrong: %+v", *s)
		}
	})

	t.Run("generic reuses provider.vault", func(t *testing.T) {
		vc := saasSecretProject("generic",
			map[string]any{"address": "https://openbao.internal:8200", "token": "t"},
			map[string]any{"mount_path": "secret"})
		s, err := DominantSecretsSaaSStore(vc)
		if err != nil || s == nil {
			t.Fatalf("generic store: s=%+v err=%v", s, err)
		}
		if s.Kind != "vault" || s.StoreName != "secretstore-generic" || s.Version != "v2" /* default */ {
			t.Fatalf("generic descriptor wrong: %+v", *s)
		}
	})

	t.Run("infisical carries two auth keys and a slug scope", func(t *testing.T) {
		vc := saasSecretProject("infisical",
			map[string]any{"client_id": "cid", "client_secret": "csec"},
			map[string]any{"workspace_id": "ws-1234", "project_slug": "payments-fujo", "env_slug": "prod"})
		s, err := DominantSecretsSaaSStore(vc)
		if err != nil || s == nil {
			t.Fatalf("infisical store: s=%+v err=%v", s, err)
		}
		if s.Kind != "infisical" || s.StoreName != "secretstore-infisical" ||
			s.CredKey("clientId") != "clientId" || s.CredKey("clientSecret") != "clientSecret" ||
			s.EnvironmentSlug != "prod" || s.SecretsPath != "/" /* default */ ||
			s.HostAPI != "https://app.infisical.com" /* default */ {
			t.Fatalf("infisical descriptor wrong: %+v", *s)
		}
		// The scope must carry the SLUG, never the workspace id — ESO resolves nothing from an id, and
		// it fails silently at deploy rather than at config time.
		if s.ProjectSlug != "payments-fujo" {
			t.Fatalf("ProjectSlug must be the slug, got %q", s.ProjectSlug)
		}
		// Both credential fields must be declared, so the seeder writes a Secret that can authenticate.
		if len(s.Creds) != 2 ||
			s.Creds[0].CredentialField != "client_id" || s.Creds[1].CredentialField != "client_secret" {
			t.Fatalf("infisical must seed client_id + client_secret, got %+v", s.Creds)
		}
	})

	t.Run("infisical fails closed without a project slug", func(t *testing.T) {
		// workspace_id alone is what the tofu write path needs; the in-cluster read needs the slug. A
		// project missing it must be rejected at the pre-plan gate rather than rendering a store whose
		// secretsScope points nowhere.
		vc := saasSecretProject("infisical",
			map[string]any{"client_id": "cid", "client_secret": "csec"},
			map[string]any{"workspace_id": "ws-1234"})
		if s, err := DominantSecretsSaaSStore(vc); err == nil || s != nil {
			t.Fatalf("expected fail-closed error for infisical with no project_slug: s=%+v err=%v", s, err)
		}
	})

	t.Run("fail-closed on missing credential", func(t *testing.T) {
		// Vault selected but no token reached the job → Validate fails → no store (fail-closed), so we
		// never render an ESO store pointing at a Secret the seeder would refuse to write.
		vc := saasSecretProject("vault", map[string]any{"address": "https://v:8200"}, nil)
		if s, err := DominantSecretsSaaSStore(vc); err == nil || s != nil {
			t.Fatalf("expected fail-closed error for vault with no token: s=%+v err=%v", s, err)
		}
	})

	t.Run("excluded and native return nil", func(t *testing.T) {
		// onepassword is a documented runtime-read exclusion → no SaaS store.
		op := saasSecretProject("onepassword", map[string]any{"service_account_token": "t"}, map[string]any{"vault": "uuid"})
		if s, err := DominantSecretsSaaSStore(op); err != nil || s != nil {
			t.Fatalf("onepassword must yield no SaaS store: s=%+v err=%v", s, err)
		}
		// No secrets selected → nil, no error.
		if s, err := DominantSecretsSaaSStore(&types.ProjectConfig{}); err != nil || s != nil {
			t.Fatalf("no secrets → nil SaaS store: s=%+v err=%v", s, err)
		}
	})
}
