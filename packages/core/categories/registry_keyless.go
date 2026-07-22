// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// KeylessRegistryTarget describes a cross-account container registry (ECR/GAR/ACR living in a
// DIFFERENT account/project/subscription than the cluster) that a Project pulls from KEYLESSLY. No
// credential is stored: the `<slug>-pull` dockerconfigjson Secret is minted + refreshed in-cluster by
// the `alethia registry-token` refresher (a Deployment running the runner image under the app's
// Workload Identity), which the target account trusts. This struct carries everything the refresher +
// its tofu pull role need; it is built from the connector's provider_config (no secret fields).
type KeylessRegistryTarget struct {
	Slug         string // e.g. "ecr-xacct" — the pull Secret is "<Slug>-pull"
	Provider     string // "aws" | "gcp" | "azure"
	RegistryHost string // the dockerconfig `auths` key (e.g. <acct>.dkr.ecr.<region>.amazonaws.com)
	Region       string

	// The cross-account target + its trust anchor (an identity REFERENCE, never a key). Exactly one
	// of the id fields is set per provider.
	TargetAccountID      string // aws
	TargetProjectID      string // gcp
	TargetSubscriptionID string // azure
	// TargetIdentityRef is the customer-created trust anchor in the target account: an IAM role ARN
	// the cluster assumes (aws), or the reader service account (gcp) / pull identity client id (azure)
	// the target granted. The refresher + the cluster-side tofu pull role consume it.
	TargetIdentityRef string
}

// SecretName is the imagePullSecret name for this target — "<slug>-pull", matching
// DominantRegistryPullSecret (#1007's pod attach) and the static-secret convention.
func (t KeylessRegistryTarget) SecretName() string { return t.Slug + "-pull" }

// DominantRegistryKeylessTarget returns the cross-account keyless registry target for the project's
// dominant registry selection, or nil when the dominant registry is native/none or a credential-based
// (static-secret) provider. Parallels DominantRegistryPullSecretSpec: the two are mutually exclusive
// for a given project (a registry is either keyless-refreshed or statically-seeded). Fail-closed —
// a selected-but-misconfigured keyless registry returns an error, never a half-built target.
func DominantRegistryKeylessTarget(vc *types.ProjectConfig) (*KeylessRegistryTarget, error) {
	slug, items := dominantProvider(registryItems(vc), io.Discard, "registry")
	if !IsPluggable(slug) || !IsKeylessRegistry(slug) {
		return nil, nil
	}
	p, err := Get("registry", slug)
	if err != nil {
		return nil, err
	}
	ctx := ComponentContext{
		Project:        vc,
		ProviderConfig: registryProviderConfig(vc, slug),
		Items:          items,
	}
	if err := p.Validate(ctx); err != nil {
		return nil, err
	}
	t, ok := p.KeylessRegistry(ctx)
	if !ok {
		return nil, nil
	}
	return &t, nil
}

// registryProviderConfig returns the provider_config of the first registry item matching slug (the
// keyless registries are singletons in practice — one cross-account target per project). Keyless
// providers read their target from provider_config, not credentials.
func registryProviderConfig(vc *types.ProjectConfig, slug string) map[string]any {
	for _, r := range vc.ContainerRegistries {
		if r.Provider == slug {
			return r.ProviderConfig
		}
	}
	return nil
}
