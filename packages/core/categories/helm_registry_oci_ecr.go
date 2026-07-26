// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Amazon ECR / ECR Public as OCI Helm registries — KEYLESS. ECR authenticates with a ~12h ephemeral
// token (`ecr get-login-password`), so no stable stored password can back a static ArgoCD repository
// credential — a seeded Secret would silently expire mid-day. Instead of a repoCred (static seed), these
// register a keylessRepoCred: an in-cluster `helm-repo-token` refresher (mirroring the registry_keyless.go
// / registry-token image pattern the cross-account container registries use) mints + refreshes the token
// from the connected AWS connector and patches the repo-helm-<hash> Secret. repoCred stays nil so
// IsHelmRegistry is false and the static HelmRepoCredSpecs path skips them; the keyless path is routed by
// IsKeylessHelmRegistry / KeylessHelmRepoTargets. ECR is an AWS-only service, so there is no non-AWS
// analogue to exclude (cloud-parity: N/A — this fully closes the former coming_soon exclusion).
func init() {
	// oci-ecr — private cross-account ECR. Reads the customer's target account + role (which trusts the
	// cluster IRSA and grants ECR pull) from provider_config; no credential fields.
	register("helm_registry", "oci-ecr", behavior{
		validate: func(ctx ComponentContext) error {
			pc := ctx.ProviderConfig
			if pcString(pc, "target_account_id", "") == "" {
				return fmt.Errorf("cross-account ECR (OCI Helm): target AWS account id not set (provider_config.target_account_id)")
			}
			if pcString(pc, "region", "") == "" {
				return fmt.Errorf("cross-account ECR (OCI Helm): region not set (provider_config.region)")
			}
			if pcString(pc, "registry_host", "") == "" {
				return fmt.Errorf("cross-account ECR (OCI Helm): registry host not set (provider_config.registry_host)")
			}
			if pcString(pc, "target_role_arn", "") == "" {
				return fmt.Errorf("cross-account ECR (OCI Helm): target role ARN not set (provider_config.target_role_arn — the role in the registry account that trusts the cluster and grants ECR pull)")
			}
			return nil
		},
		keylessRepoCred: func(ctx ComponentContext) KeylessHelmRepoTarget {
			pc := ctx.ProviderConfig
			return KeylessHelmRepoTarget{
				Slug:            "oci-ecr",
				Provider:        "aws",
				RegistryHost:    pcString(pc, "registry_host", ""),
				Region:          pcString(pc, "region", ""),
				TargetAccountID: pcString(pc, "target_account_id", ""),
				TargetRoleArn:   pcString(pc, "target_role_arn", ""),
			}
		},
	})

	// oci-public-ecr — ECR Public (public.ecr.aws), a single fixed host. The in-cluster refresher mints a
	// public-ECR token under the cluster's OWN IRSA (us-east-1), no cross-account role. The host is fixed
	// (never taken from arbitrary provider_config) so no host-trust gap.
	register("helm_registry", "oci-public-ecr", behavior{
		validate: func(ctx ComponentContext) error {
			if pcString(ctx.ProviderConfig, "registry_host", "public.ecr.aws") == "" {
				return fmt.Errorf("ECR Public (OCI Helm): registry host is empty")
			}
			return nil
		},
		keylessRepoCred: func(ctx ComponentContext) KeylessHelmRepoTarget {
			return KeylessHelmRepoTarget{
				Slug:         "oci-public-ecr",
				Provider:     "aws",
				RegistryHost: pcString(ctx.ProviderConfig, "registry_host", "public.ecr.aws"),
				Region:       "us-east-1",
				Public:       true,
			}
		},
	})
}
