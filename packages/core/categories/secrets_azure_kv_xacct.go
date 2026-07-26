// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Azure Key Vault (cross-subscription, keyless) — read secrets from a Key Vault in a DIFFERENT Azure
// subscription than the cluster, with no stored key. The in-cluster External Secrets Operator
// authenticates with the cluster's AKS workload identity (authType: WorkloadIdentity) and reads the
// target vault by URL; the customer bootstrap grants the "Key Vault Secrets User" role on the target
// vault to our workload-identity principal (Model B).
//
// Same-tenant, cross-subscription only. Cross-TENANT keyless Key Vault access is a hard Azure platform
// limit (a managed / workload identity cannot be used across tenants) — it needs a customer-created app
// registration + federated credential in the vault's tenant, and is a documented exclusion, not a lane.
func init() {
	register("secrets", "azure-kv-xacct", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_subscription_id", "") == "" {
				return fmt.Errorf("cross-subscription Azure Key Vault: target subscription id not set (provider_config.target_subscription_id)")
			}
			if pcString(pc, "vault_url", "") == "" {
				return fmt.Errorf("cross-subscription Azure Key Vault: target vault URL not set (provider_config.vault_url — e.g. https://my-vault.vault.azure.net, in the target subscription and SAME tenant)")
			}
			return nil
		},
		keylessSecretStore: func(ctx ComponentContext) KeylessSecretTarget {
			pc := ctx.ProviderConfig
			return KeylessSecretTarget{
				Slug:                 "azure-kv-xacct",
				Provider:             "azure",
				TargetSubscriptionID: pcString(pc, "target_subscription_id", ""),
				TargetRef:            pcString(pc, "vault_url", ""),
			}
		},
	})
}
