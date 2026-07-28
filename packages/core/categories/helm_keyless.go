// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"errors"
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// KeylessHelmRepoTarget describes a cross-account OCI Helm chart registry (Amazon ECR in a DIFFERENT AWS
// account than the cluster, or ECR Public at public.ecr.aws) that a Project pulls charts from KEYLESSLY.
// No credential is stored: ECR issues a ~12h auth token, so the `repo-helm-<hash>` ArgoCD repo-cred
// Secret cannot hold a stable password. Instead an in-cluster `helm-repo-token` refresher (a Deployment
// running the runner image under the cluster Workload Identity) mints + refreshes the token and patches
// username=AWS / password=<token> into the pre-seeded Secret. This struct carries everything the
// refresher + its tofu pull role need; it is built from the connector's provider_config (no secret
// fields). It is the helm_registry analogue of KeylessRegistryTarget (the image-pull side).
type KeylessHelmRepoTarget struct {
	Slug         string // "oci-ecr" | "oci-public-ecr"
	Provider     string // "aws" — ECR is an AWS-only service
	RegistryHost string // OCI host: <acct>.dkr.ecr.<region>.amazonaws.com (private) or public.ecr.aws
	Region       string

	// The cross-account target + its trust anchor (an identity REFERENCE, never a key). Empty for Public
	// ECR, which the cluster's own IRSA can read anonymously via ecr-public:GetAuthorizationToken.
	TargetAccountID string
	TargetRoleArn   string // the customer-created role in the registry account that trusts the cluster IRSA
	Public          bool   // ECR Public (public.ecr.aws) — no cross-account role
}

// RepoURL is the oci:// chart-repo URL ArgoCD matches an Application to (prefix match). The placeholder
// repo-cred Secret and the refresher's patch target derive their name from it, identically to the static
// path (HelmRepoCredSecretName), so the Secret the refresher patches is named exactly as ArgoCD expects.
func (t KeylessHelmRepoTarget) RepoURL() string { return "oci://" + t.RegistryHost }

// SecretName is the deterministic ArgoCD repo-cred Secret name for this target — the SAME derivation as
// the static path, so the pre-seeded placeholder and the refresher patch agree by construction.
func (t KeylessHelmRepoTarget) SecretName() string { return HelmRepoCredSecretName(t.RepoURL()) }

// KeylessHelmRepoTargets returns the cross-account keyless OCI Helm registry targets for a project's
// connected chart repos (vc.HelmRegistries). Parallels HelmRepoCredSpecs (the static-secret path): the
// two are mutually exclusive per slug — a helm registry is either keyless-refreshed (ECR) or statically
// seeded. Multi-repo, not a dominant singleton: a project may connect several ECR chart repos, so this
// returns one target per distinct repo (deduped by Secret name). Fail-closed: a selected-but-
// misconfigured keyless entry is SKIPPED (never a half-built target) with its error joined for the
// caller to log — one bad repo must not sink the others.
func KeylessHelmRepoTargets(vc *types.ProjectConfig) ([]KeylessHelmRepoTarget, error) {
	var (
		targets []KeylessHelmRepoTarget
		errs    []error
		seen    = map[string]struct{}{}
	)
	for _, r := range vc.HelmRegistries {
		if !IsPluggable(r.Provider) || !IsKeylessHelmRegistry(r.Provider) {
			continue
		}
		p, err := Get("helm_registry", r.Provider)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		// Keyless: the target is read from provider_config, never credentials.
		ctx := ComponentContext{
			Project:        vc,
			ProviderConfig: r.ProviderConfig,
		}
		if err := p.Validate(ctx); err != nil {
			errs = append(errs, fmt.Errorf("helm_registry/%s validation failed: %w", r.Provider, err))
			continue
		}
		t, ok := p.KeylessRepoCred(ctx)
		if !ok {
			continue
		}
		name := t.SecretName()
		if _, dup := seen[name]; dup {
			// Same repo URL connected twice — one refresher/Secret already covers it.
			continue
		}
		seen[name] = struct{}{}
		targets = append(targets, t)
	}
	return targets, errors.Join(errs...)
}
