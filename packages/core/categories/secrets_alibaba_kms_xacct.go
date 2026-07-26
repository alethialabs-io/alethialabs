// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Alibaba Cloud KMS Secrets Manager (cross-RAM-account, keyless) — read secrets from a KMS Secrets
// Manager in a DIFFERENT Alibaba RAM account than the cluster, with no stored key. The in-cluster
// External Secrets Operator authenticates with the cluster's RRSA (RAM Roles for Service Accounts)
// identity and assumes the customer-created target-account RAM role (which trusts the cluster's RRSA
// OIDC provider and grants KMS secret read). No credential fields — the connector references the
// target RAM role via provider_config. Mirrors the existing same-account `secretstore-alibaba` RRSA
// store, extended cross-account.
func init() {
	register("secrets", "alibaba-kms-xacct", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_account_id", "") == "" {
				return fmt.Errorf("cross-account Alibaba KMS: target RAM account id not set (provider_config.target_account_id)")
			}
			if pcString(pc, "region", "") == "" {
				return fmt.Errorf("cross-account Alibaba KMS: region not set (provider_config.region)")
			}
			if pcString(pc, "target_role_arn", "") == "" {
				return fmt.Errorf("cross-account Alibaba KMS: target role ARN not set (provider_config.target_role_arn — the acs:ram role in the secrets account that trusts the cluster RRSA and grants KMS secret read)")
			}
			if pcString(pc, "target_oidc_provider_arn", "") == "" {
				return fmt.Errorf("cross-account Alibaba KMS: target OIDC provider ARN not set (provider_config.target_oidc_provider_arn — the RAM OIDC provider in the secrets account trusting this cluster's ACK OIDC issuer; ESO RRSA exchanges its projected token for the target role via it)")
			}
			return nil
		},
		keylessSecretStore: func(ctx ComponentContext) KeylessSecretTarget {
			pc := ctx.ProviderConfig
			return KeylessSecretTarget{
				Slug:                  "alibaba-kms-xacct",
				Provider:              "alibaba",
				Region:                pcString(pc, "region", ""),
				TargetAccountID:       pcString(pc, "target_account_id", ""),
				TargetRef:             pcString(pc, "target_role_arn", ""),
				TargetOIDCProviderRef: pcString(pc, "target_oidc_provider_arn", ""),
			}
		},
	})
}
