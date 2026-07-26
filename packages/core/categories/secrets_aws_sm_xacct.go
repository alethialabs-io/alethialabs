// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// AWS Secrets Manager (cross-account, keyless) — read secrets from a Secrets Manager in a DIFFERENT
// AWS account than the cluster, with no stored key. The in-cluster External Secrets Operator, running
// under its IRSA identity, assumes the customer-created target-account role (which trusts the cluster
// IRSA and grants secretsmanager:GetSecretValue) and reads across the account boundary. No credential
// fields — the connector references the target role in the registry account via provider_config.
func init() {
	register("secrets", "aws-sm-xacct", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_account_id", "") == "" {
				return fmt.Errorf("cross-account AWS Secrets Manager: target AWS account id not set (provider_config.target_account_id)")
			}
			if pcString(pc, "region", "") == "" {
				return fmt.Errorf("cross-account AWS Secrets Manager: region not set (provider_config.region)")
			}
			if pcString(pc, "target_role_arn", "") == "" {
				return fmt.Errorf("cross-account AWS Secrets Manager: target role ARN not set (provider_config.target_role_arn — the role in the secrets account that trusts the cluster and grants secretsmanager:GetSecretValue)")
			}
			return nil
		},
		keylessSecretStore: func(ctx ComponentContext) KeylessSecretTarget {
			pc := ctx.ProviderConfig
			return KeylessSecretTarget{
				Slug:            "aws-sm-xacct",
				Provider:        "aws",
				Region:          pcString(pc, "region", ""),
				TargetAccountID: pcString(pc, "target_account_id", ""),
				TargetRef:       pcString(pc, "target_role_arn", ""),
				// Optional: only meaningful when the customer's bootstrap put an sts:ExternalId
				// condition on the target role's trust policy. Deliberately NOT validated — a role
				// without that condition is the default and must keep working.
				TargetExternalID: pcString(pc, "external_id", ""),
			}
		},
	})
}
