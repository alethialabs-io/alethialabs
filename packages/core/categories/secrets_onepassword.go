// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// 1Password — a SaaS external secrets store. The tofu module manages a placeholder `onepassword_item`
// (a password item) per project secret in the connection's vault (apps/operators populate real
// values). Auth is a 1Password Service Account token, which supports creating items in v3.x. The vault
// is referenced by its UUID.
func init() {
	register("secrets", "onepassword", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			return map[string]any{
				"op_service_account_token": cred(ctx.Credentials, "service_account_token", ""),
				"op_vault":                 pcString(ctx.ProviderConfig, "vault", ""),
				"secret_names":             itemNames(ctx.Items),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "service_account_token", "") == "" {
				return fmt.Errorf("1Password credential not connected (missing service account token)")
			}
			if pcString(ctx.ProviderConfig, "vault", "") == "" {
				return fmt.Errorf("1Password vault not set (provider_config.vault — the vault UUID)")
			}
			return nil
		},
	})
}
