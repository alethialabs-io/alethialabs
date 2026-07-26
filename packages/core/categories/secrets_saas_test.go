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
	// Runtime-read first-class stores on the pinned ESO chart.
	for _, slug := range []string{"vault", "doppler", "generic"} {
		if !IsSaaSSecretStore(slug) {
			t.Errorf("%s should be a SaaS secret store", slug)
		}
	}
	// Documented runtime-read exclusions (infisical needs ESO ≥0.9.20; 1Password is Connect-only) and
	// the cross-account keyless managers must NOT be SaaS runtime-read stores.
	for _, slug := range []string{"infisical", "onepassword", "aws-sm-xacct", "native", ""} {
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
			s.CredSecret != "secretstore-vault-creds" || s.CredKey != "token" ||
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
		if s.Kind != "doppler" || s.StoreName != "secretstore-doppler" || s.CredKey != "dopplerToken" ||
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
