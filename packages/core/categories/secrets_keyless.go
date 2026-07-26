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

	// TargetExternalID is set for AWS only, and is OPTIONAL there. When the customer's bootstrap sets
	// an `sts:ExternalId` condition on the target role's trust policy, the same value must be sent on
	// the assume or STS rejects it — ESO carries it as spec.provider.aws.externalID. Empty means the
	// trust policy has no ExternalId condition (the default), and the field is omitted from the store.
	//
	// AWS-ONLY BY DESIGN — an explicit, documented per-cloud exclusion, not an oversight: ExternalId is
	// an STS-specific confused-deputy control with no equivalent on the other three lanes, each of which
	// already binds the grant to a concrete principal. GCP binds `roles/secretmanager.secretAccessor` to
	// the cluster's Workload-Identity service account per secret; Azure assigns "Key Vault Secrets User"
	// to the workload identity's service principal on one vault; Alibaba pins the RRSA trust to the
	// cluster's OIDC issuer AND the external-secrets ServiceAccount `oidc:sub`.
	TargetExternalID string
}

// XacctStoreName is the NAME of the cross-account ClusterSecretStore rendered for a cloud —
// "secretstore-<cloud>-xacct", matching externalSecretsStoreTemplate's *-xacct branches. Returns ""
// for a cloud with no cross-account store (hetzner, unknown), so callers fail closed.
//
// Keyed on the CLOUD, never the connector slug: the slug is "aws-sm-xacct" but the store is
// "secretstore-aws-xacct", so the tempting "secretstore-"+slug is wrong on every lane.
func XacctStoreName(cloud string) string {
	switch cloud {
	case "aws", "gcp", "azure", "alibaba":
		return "secretstore-" + cloud + "-xacct"
	default:
		return ""
	}
}

// AllXacctStoreNames returns every cross-account ClusterSecretStore name the template can render.
// Callers that reap stale stores enumerate this instead of re-listing the clouds, so a new lane
// cannot be added to the template and silently forgotten by the cleanup.
func AllXacctStoreNames() []string {
	return []string{
		XacctStoreName("aws"),
		XacctStoreName("gcp"),
		XacctStoreName("azure"),
		XacctStoreName("alibaba"),
	}
}

// StoreName is the cross-account ClusterSecretStore this target is read through.
func (t KeylessSecretTarget) StoreName() string { return XacctStoreName(t.Provider) }

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
