// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Amazon ECR (cross-account, keyless) — pull from an ECR registry in a DIFFERENT AWS account than the
// cluster, with no stored key. The in-cluster `registry-token` refresher assumes the customer-created
// target role (which trusts the cluster IRSA) and mints an ECR auth token every ~11h. No credential
// fields — the connector references an IAM role in the target account via provider_config.
func init() {
	register("registry", "ecr-xacct", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_account_id", "") == "" {
				return fmt.Errorf("cross-account ECR: target AWS account id not set (provider_config.target_account_id)")
			}
			if pcString(pc, "region", "") == "" {
				return fmt.Errorf("cross-account ECR: region not set (provider_config.region)")
			}
			if pcString(pc, "registry_host", "") == "" {
				return fmt.Errorf("cross-account ECR: registry host not set (provider_config.registry_host)")
			}
			if pcString(pc, "target_role_arn", "") == "" {
				return fmt.Errorf("cross-account ECR: target role ARN not set (provider_config.target_role_arn — the role in the registry account that trusts the cluster and grants ECR pull)")
			}
			return nil
		},
		keylessRegistry: func(ctx ComponentContext) KeylessRegistryTarget {
			pc := ctx.ProviderConfig
			return KeylessRegistryTarget{
				Slug:              "ecr-xacct",
				Provider:          "aws",
				RegistryHost:      pcString(pc, "registry_host", ""),
				Region:            pcString(pc, "region", ""),
				TargetAccountID:   pcString(pc, "target_account_id", ""),
				TargetIdentityRef: pcString(pc, "target_role_arn", ""),
			}
		},
	})
}
