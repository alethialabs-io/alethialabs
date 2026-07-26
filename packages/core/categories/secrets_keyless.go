// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// KeylessSecretTarget describes a cross-account cloud secret manager (AWS Secrets Manager / GCP Secret
// Manager / Azure Key Vault / Alibaba KMS Secrets Manager) living in a DIFFERENT account / project /
// subscription than the cluster, that the project's workloads read from KEYLESSLY. No credential is
// stored: the in-cluster External Secrets Operator (ESO) authenticates with the cluster's own workload
// identity and reads across the account boundary via a customer-created trust anchor in the target
// account (Model B — the customer bootstraps a least-privilege read grant that trusts our cluster
// identity; we never hold admin in the target account). This struct carries everything the rendered
// ClusterSecretStore + the cluster-side assume leg need; it is built from the connector's
// provider_config (no secret fields).
//
// Unlike the cross-account registry (KeylessRegistryTarget), there is NO in-cluster token refresher:
// ESO itself performs the cross-account read (spec.provider.aws.role / gcpsm.projectID /
// azurekv.vaultUrl / alibaba.auth.rrsa.roleArn), so the target is referenced directly by the store.
type KeylessSecretTarget struct {
	Slug     string // e.g. "aws-sm-xacct"
	Provider string // "aws" | "gcp" | "azure" | "alibaba"
	Region   string

	// The cross-account target ids (an id per provider; exactly one set is meaningful per Provider).
	TargetAccountID      string // aws, alibaba (target RAM account)
	TargetProjectID      string // gcp (the target project the store reads — gcpsm.projectID)
	TargetSubscriptionID string // azure

	// TargetRef is the customer-created trust anchor / address the cluster ESO identity reads through:
	//   aws / alibaba → the target-account role ARN the ESO identity assumes (spec.provider.aws.role,
	//                   spec.provider.alibaba.auth.rrsa.roleArn)
	//   azure         → the target Key Vault URL (spec.provider.azurekv.vaultUrl)
	//   gcp           → empty (projectID IS the address; the read grant lives in the target project,
	//                   bound to our Workload-Identity principal by the customer bootstrap)
	// It is always an identity / resource REFERENCE, never a key.
	TargetRef string

	// TargetOIDCProviderRef is set for ALIBABA only. ESO's alibaba RRSA auth performs a single
	// AssumeRoleWithOIDC (no AWS-style role-to-role chaining), so a cross-RAM-account read requires the
	// TARGET account to host its own RAM OIDC provider trusting the cluster's ACK OIDC issuer; the store
	// exchanges the projected token for the target role via that provider. The customer bootstrap
	// creates the provider + role in the target account and supplies this ARN. Empty for other clouds.
	TargetOIDCProviderRef string
}

// DominantKeylessSecretTarget returns the cross-account keyless secret-manager target for the project's
// dominant secrets selection, or nil when the dominant secrets provider is native / none or a
// credential-based (Vault / Doppler / Infisical / 1Password) store. Parallels
// DominantRegistryKeylessTarget: a cross-account cloud secret manager is an ADDITIONAL read source
// layered on the native store, so it never flips the native secrets gate. Fail-closed — a
// selected-but-misconfigured target returns an error, never a half-built target.
func DominantKeylessSecretTarget(vc *types.ProjectConfig) (*KeylessSecretTarget, error) {
	slug, items := dominantProvider(secretItems(vc), io.Discard, "secrets")
	if !IsPluggable(slug) || !IsKeylessSecretStore(slug) {
		return nil, nil
	}
	p, err := Get("secrets", slug)
	if err != nil {
		return nil, err
	}
	ctx := ComponentContext{
		Project:        vc,
		ProviderConfig: secretsProviderConfig(vc, slug),
		Items:          items,
	}
	if err := p.Validate(ctx); err != nil {
		return nil, err
	}
	t, ok := p.KeylessSecretStore(ctx)
	if !ok {
		return nil, nil
	}
	return &t, nil
}
