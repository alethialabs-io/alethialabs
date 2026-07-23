// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Infisical — a SaaS/self-hostable external secrets store. The tofu module manages a placeholder
// `infisical_secret` per project secret in the connection's workspace/env/folder (apps/operators
// populate real values). Auth is Universal Auth (a machine-identity client_id + client_secret; the
// legacy service token is deprecated). `host` allows a self-hosted Infisical instance.
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
			return nil
		},
	})
}
