// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Azure Container Registry (cross-subscription, keyless) — pull from an ACR in a DIFFERENT Azure
// subscription than the cluster, with no stored key. The in-cluster `registry-token` refresher
// exchanges the cluster pull UAMI's AAD token for an ACR refresh token (the target ACR granted that
// UAMI AcrPull). No credential fields — the connector references the target subscription + ACR via
// provider_config.
func init() {
	register("registry", "acr-xacct", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_subscription_id", "") == "" {
				return fmt.Errorf("cross-subscription ACR: target Azure subscription id not set (provider_config.target_subscription_id)")
			}
			if pcString(pc, "registry_host", "") == "" {
				return fmt.Errorf("cross-subscription ACR: registry host not set (provider_config.registry_host, e.g. <registry>.azurecr.io)")
			}
			if pcString(pc, "target_identity_client_id", "") == "" {
				return fmt.Errorf("cross-subscription ACR: target pull identity client id not set (provider_config.target_identity_client_id — the identity the target ACR granted AcrPull)")
			}
			return nil
		},
		keylessRegistry: func(ctx ComponentContext) KeylessRegistryTarget {
			pc := ctx.ProviderConfig
			return KeylessRegistryTarget{
				Slug:                 "acr-xacct",
				Provider:             "azure",
				RegistryHost:         pcString(pc, "registry_host", ""),
				Region:               pcString(pc, "region", ""),
				TargetSubscriptionID: pcString(pc, "target_subscription_id", ""),
				TargetIdentityRef:    pcString(pc, "target_identity_client_id", ""),
			}
		},
	})
}
