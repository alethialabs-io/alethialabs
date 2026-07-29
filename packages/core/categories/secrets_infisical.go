// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Infisical — a SaaS/self-hostable external secrets store. The tofu module manages a placeholder
// `infisical_secret` per project secret in the connection's workspace/env/folder (apps/operators
// populate real values). Auth is Universal Auth (a machine-identity client_id + client_secret; the
// legacy service token is deprecated). `host` allows a self-hosted Infisical instance.
//
// Infisical addresses one project by TWO different identifiers, and both are collected:
// `workspace_id` (the id) is what the tofu write path uses, and `project_slug` (the slug, copied from
// Infisical's project settings) is what ESO's secretsScope wants for the in-cluster read. They are
// not interchangeable.
func init() {
	register("secrets", "infisical", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			return map[string]any{
				"infisical_host":          pcString(ctx.ProviderConfig, "host", "https://app.infisical.com"),
				"infisical_client_id":     cred(ctx.Credentials, "client_id", ""),
				"infisical_client_secret": cred(ctx.Credentials, "client_secret", ""),
				"infisical_workspace_id":  pcString(ctx.ProviderConfig, "workspace_id", ""),
				"infisical_env_slug":      pcString(ctx.ProviderConfig, "env_slug", "dev"),
				"infisical_folder_path":   pcString(ctx.ProviderConfig, "folder_path", "/"),
				"secret_names":            itemNames(ctx.Items),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "client_id", "") == "" || cred(ctx.Credentials, "client_secret", "") == "" {
				return fmt.Errorf("Infisical credential not connected (missing machine-identity client_id or client_secret)")
			}
			if pcString(ctx.ProviderConfig, "workspace_id", "") == "" {
				return fmt.Errorf("Infisical workspace not set (provider_config.workspace_id)")
			}
			// Required for the in-cluster read (secretsScope.projectSlug). Gated here — the same
			// pre-plan gate workspace_id uses — so a project missing it is rejected by Compose with a
			// field to fill in, rather than rendering a ClusterSecretStore that silently resolves
			// nothing at deploy. Infisical was un-selectable for secrets until this shipped (the
			// console's runtime-read exclusion), so this tightens configuration rather than breaking a
			// working one.
			if pcString(ctx.ProviderConfig, "project_slug", "") == "" {
				return fmt.Errorf("Infisical project slug not set (provider_config.project_slug — copy it from the project settings; it is NOT the workspace id)")
			}
			return nil
		},
		// Runtime-read: ESO reads Infisical via spec.provider.infisical, first-class from chart 0.9.20
		// (the pin this shipped with). Universal Auth needs TWO SecretKeySelectors — clientId and
		// clientSecret — so the seeded credential Secret carries two keys, unlike the single token
		// vault/doppler seed.
		saasSecretStore: func(ctx ComponentContext) SecretsSaaSStore {
			return SecretsSaaSStore{
				Slug:       "infisical",
				Kind:       "infisical",
				StoreName:  "secretstore-infisical",
				CredSecret: "secretstore-infisical-creds",
				Creds: []SecretsSaaSCredRef{
					{Role: SaaSCredClientID, Key: "clientId", CredentialField: "client_id"},
					{Role: SaaSCredClientSecret, Key: "clientSecret", CredentialField: "client_secret"},
				},
				Namespace:       secretsSaaSNamespace,
				HostAPI:         pcString(ctx.ProviderConfig, "host", "https://app.infisical.com"),
				ProjectSlug:     pcString(ctx.ProviderConfig, "project_slug", ""),
				EnvironmentSlug: pcString(ctx.ProviderConfig, "env_slug", "dev"),
				SecretsPath:     pcString(ctx.ProviderConfig, "folder_path", "/"),
			}
		},
	})
}
