// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Generic KV store — the long-tail external secrets store, scoped (by documented design) to a
// Vault-KV-API-compatible endpoint (HashiCorp Vault, OpenBao, or any server exposing the Vault KV v2
// HTTP API). A bare arbitrary HTTP KV API has no first-party OpenTofu create-secret resource and no
// static-token ESO provider, so it cannot fit the placeholder-provision + runtime-read model; a
// Vault-compatible endpoint does, so `generic` reuses the vault module (write/placeholder) and the
// spec.provider.vault ESO ClusterSecretStore (runtime-read) verbatim — it is `vault` under a
// provider-neutral label. See infra/templates/project/CUSTOMIZABILITY-PARITY.md.
func init() {
	register("secrets", "generic", behavior{
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
				return fmt.Errorf("Generic KV store not connected (missing endpoint address or token — a Vault-KV-API-compatible endpoint is required)")
			}
			return nil
		},
		// Runtime-read via spec.provider.vault (the endpoint speaks the Vault KV v2 HTTP API).
		saasSecretStore: func(ctx ComponentContext) SecretsSaaSStore {
			return vaultSaaSStore(ctx, "generic")
		},
	})
}
