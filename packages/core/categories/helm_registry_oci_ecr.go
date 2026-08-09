// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"fmt"
	"strings"
)

// publicECRRegistryHost is the single global host ECR Public serves from. It is a constant, not a
// provider_config input: the refresher mints the token under the CLUSTER's own IRSA, so seeding it
// against an operator-supplied host would hand that token to a registry the customer never connected.
const publicECRRegistryHost = "public.ecr.aws"

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
		// registry_host is not an input here — the host is pinned to publicECRRegistryHost. A
		// provider_config that carries the key anyway is accepted only when it names that same host, and
		// rejected loudly otherwise rather than silently ignored, so a snapshot written against a
		// different registry never reaches the refresher.
		//
		// The raw map entry is read deliberately: pcString substitutes its default for a missing, null OR
		// EXPLICITLY-EMPTY value, so a `== ""` test against a non-empty default can never be true and the
		// guard that used to stand here was unreachable (#2087). Absent and null stay unset — that is
		// pcString's own reading of them, and the pinned host covers it.
		validate: func(ctx ComponentContext) error {
			v, set := ctx.ProviderConfig["registry_host"]
			if !set || v == nil {
				return nil
			}
			if h, isString := v.(string); !isString || strings.TrimSpace(h) != publicECRRegistryHost {
				return fmt.Errorf("ECR Public (OCI Helm): registry host is fixed at %s (provider_config.registry_host = %#v)", publicECRRegistryHost, v)
			}
			return nil
		},
		keylessRepoCred: func(ctx ComponentContext) KeylessHelmRepoTarget {
			return KeylessHelmRepoTarget{
				Slug:         "oci-public-ecr",
				Provider:     "aws",
				RegistryHost: publicECRRegistryHost,
				Region:       "us-east-1",
				Public:       true,
			}
		},
	})
}
