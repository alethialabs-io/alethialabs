// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// HashiCorp Vault — pluggable alternative to the cloud-native secrets store.
func init() {
	register("secrets", "vault", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			return map[string]any{
				"vault_address":    cred(ctx.Credentials, "address", ""),
				"vault_token":      cred(ctx.Credentials, "token", ""),
				"vault_mount_path": pcString(ctx.ProviderConfig, "mount_path", "secret"),
				"vault_kv_version": pcString(ctx.ProviderConfig, "kv_version", "2"),
				"secret_names":     itemNames(ctx.Items),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "address", "") == "" || cred(ctx.Credentials, "token", "") == "" {
				return fmt.Errorf("Vault credential not connected (missing address or token)")
			}
			return nil
		},
	})
}
