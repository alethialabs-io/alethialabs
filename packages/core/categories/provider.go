// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package categories implements the pluggable per-category connector providers
// (DNS / secrets / registry / observability) that decouple WHAT a Project needs from
// WHO provides it. It mirrors packages/core/cloud one level down: declarative data
// (slug, category, module path, credential shape) lives in catalog.json — the SAME
// manifest the console codegen consumes — and behavior (Tfvars/Validate) lives in
// the per-slug impls registered in this package's init().
package categories

import (
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

//go:embed catalog.json
var catalogJSON []byte

// ComponentItem is one element of a multi-component category (a registry repo, a
// secret). Singletons (dns/observability) use ComponentContext.ProviderConfig.
type ComponentItem struct {
	Name           string
	ProviderConfig map[string]any
}

// ComponentContext is everything a provider needs to emit module tfvars: the
// decrypted credential, the component's provider_config (singleton) or items
// (multi), and the surrounding Project for cross-references (domain, region, …).
type ComponentContext struct {
	Project        *types.ProjectConfig
	Credentials    map[string]string
	ProviderConfig map[string]any
	Items          []ComponentItem
}

// behavior is the per-slug logic the impls register.
type behavior struct {
	tfvars   func(ComponentContext) map[string]any
	validate func(ComponentContext) error
	// pullAuth, when set (registry category only), returns the docker registry host used as the
	// dockerconfig `auths` key plus the username/password the kubelet authenticates a pull with.
	// The runner builds a dockerconfigjson imagePullSecret from it and seeds it POST-APPLY via
	// `kubectl apply` (works on all clouds incl. AWS, where the in-tofu kubernetes provider is
	// host+CA-only and cannot create the Secret). nil → the provider has no pull-auth mapping.
	pullAuth func(ComponentContext) (host, username, password string)
	// keylessRegistry, when set (cross-account keyless registry providers: ecr/gar/acr in a DIFFERENT
	// account than the cluster), describes the target registry an in-cluster refresher mints a pull
	// token for from the app's Workload Identity — NO stored key. Mutually exclusive with pullAuth: a
	// keyless registry gets a continuously-refreshed dockerconfigjson (the refresher Deployment), not a
	// static one. nil → not a keyless registry.
	keylessRegistry func(ComponentContext) KeylessRegistryTarget
	// keylessSecretStore, when set (cross-account keyless secret-manager providers: AWS SM / GCP SM /
	// Azure KV / Alibaba KMS in a DIFFERENT account than the cluster), describes the foreign-account
	// secret store the in-cluster External Secrets Operator reads across the account boundary using the
	// cluster's own workload identity — NO stored key. It is an ADDITIONAL read source (an extra
	// ClusterSecretStore), NOT a replacement of the native store, so it never flips the native secrets
	// gate. nil → not a keyless secret store.
	keylessSecretStore func(ComponentContext) KeylessSecretTarget
	// saasSecretStore, when set (credential-based external secret stores: HashiCorp Vault / OpenBao,
	// Doppler, or a generic Vault-KV-API-compatible endpoint), describes the in-cluster ESO
	// ClusterSecretStore that reads that store with a STATIC API token seeded into an in-cluster
	// Secret. Unlike keylessSecretStore (which ESO reads keylessly via the cluster's workload
	// identity), a SaaS store has no cloud identity to federate — its token is seeded out-of-band and
	// referenced by the store's auth.secretRef. Returns NON-SECRET connection config + the seed-Secret
	// NAME only; the token itself never crosses this seam. nil → not a runtime-read SaaS secret store.
	saasSecretStore func(ComponentContext) SecretsSaaSStore
	// repoCred, when set (helm_registry category only), maps a private Helm/OCI chart-repo connection to
	// the ArgoCD repository credential the runner seeds post-apply (argocd.EnsureHelmRepoCredential):
	// the chart-repo URL (oci://host for an OCI registry, https://… for an HTTPS chart repo), the
	// username/password ArgoCD authenticates the chart pull with, and whether the repo is OCI. Unlike
	// pullAuth (a dockerconfigjson imagePullSecret for image pulls), this is an `argocd.argoproj.io/
	// secret-type` repo credential ArgoCD matches to an Application by repoURL. nil → not a helm_registry
	// provider (or a coming_soon one whose keyless resolution is a documented follow-up).
	repoCred func(ComponentContext) RepoCred
	// keylessRepoCred, when set (helm_registry ECR providers only), describes a cross-account OCI Helm
	// chart registry (Amazon ECR / ECR Public) whose repo credential CANNOT be statically seeded — ECR
	// issues a ~12h token, not a stable password. Instead an in-cluster refresher (the `helm-repo-token`
	// Deployment running the runner image under the cluster Workload Identity) mints + refreshes the
	// token and patches username=AWS / password=<token> into the pre-seeded `repo-helm-<hash>` ArgoCD
	// repo-cred Secret. Mutually exclusive with repoCred: an ECR helm registry is keyless-refreshed,
	// never statically seeded — repoCred stays nil so IsHelmRegistry is false and HelmRepoCredSpecs skips
	// it, and this routes the keyless path instead. nil → not a keyless helm registry.
	keylessRepoCred func(ComponentContext) KeylessHelmRepoTarget
}

var behaviors = map[string]behavior{}

// register wires a provider's behavior. Called from each impl's init().
func register(category, slug string, b behavior) {
	behaviors[category+"/"+slug] = b
}

// providerMeta is the declarative slice of catalog.json this package needs.
type providerMeta struct {
	Category   string `json:"category"`
	Slug       string `json:"slug"`
	ModulePath string `json:"module_path"`
}

type catalogFile struct {
	Providers []providerMeta `json:"providers"`
}

var metaIndex = map[string]providerMeta{}

func init() {
	var c catalogFile
	if err := json.Unmarshal(catalogJSON, &c); err != nil {
		panic(fmt.Sprintf("categories: invalid catalog.json: %v", err))
	}
	for _, p := range c.Providers {
		metaIndex[p.Category+"/"+p.Slug] = p
	}
}

// CategoryProvider binds declarative meta (from catalog.json) to registered
// behavior. It is the runtime handle used by Compose.
type CategoryProvider struct {
	meta providerMeta
	b    behavior
}

// Category returns the category this provider serves.
func (p *CategoryProvider) Category() string { return p.meta.Category }

// Slug returns the provider's catalog slug.
func (p *CategoryProvider) Slug() string { return p.meta.Slug }

// ModulePath returns the OpenTofu module path (relative to infra/templates).
func (p *CategoryProvider) ModulePath() string { return p.meta.ModulePath }

// Tfvars maps the component context into the module's input variables.
func (p *CategoryProvider) Tfvars(ctx ComponentContext) map[string]any {
	if p.b.tfvars == nil {
		return map[string]any{}
	}
	return p.b.tfvars(ctx)
}

// Validate guards nonsensical combinations before a plan is produced.
func (p *CategoryProvider) Validate(ctx ComponentContext) error {
	if p.b.validate == nil {
		return nil
	}
	return p.b.validate(ctx)
}

// PullAuth returns the registry host + username/password the runner builds a dockerconfigjson
// imagePullSecret from (registry providers only). ok is false when the provider registered no
// pullAuth — a non-registry provider, or a registry that authenticates some other way.
func (p *CategoryProvider) PullAuth(ctx ComponentContext) (host, username, password string, ok bool) {
	if p.b.pullAuth == nil {
		return "", "", "", false
	}
	h, u, pw := p.b.pullAuth(ctx)
	return h, u, pw, true
}

// KeylessRegistry returns the cross-account keyless registry target (ecr/gar/acr in a foreign
// account), or ok=false when the provider is not a keyless registry. A keyless registry has no
// pullAuth; its pull secret is refreshed in-cluster by the `registry-token` refresher.
func (p *CategoryProvider) KeylessRegistry(ctx ComponentContext) (KeylessRegistryTarget, bool) {
	if p.b.keylessRegistry == nil {
		return KeylessRegistryTarget{}, false
	}
	return p.b.keylessRegistry(ctx), true
}

// IsKeylessRegistry reports whether a registry slug is a cross-account keyless provider (its pull
// secret is refreshed in-cluster, not seeded statically). Cheap lookup for routing in Compose /
// DominantRegistryPullSecretSpec without building a full ComponentContext.
func IsKeylessRegistry(slug string) bool {
	b, ok := behaviors["registry/"+slug]
	return ok && b.keylessRegistry != nil
}

// KeylessSecretStore returns the cross-account keyless secret-manager target (AWS SM / GCP SM / Azure
// KV / Alibaba KMS in a foreign account), or ok=false when the provider is not a keyless secret store.
// A keyless secret store adds a foreign-account ClusterSecretStore the External Secrets Operator reads
// with the cluster's workload identity; it has no stored credential.
func (p *CategoryProvider) KeylessSecretStore(ctx ComponentContext) (KeylessSecretTarget, bool) {
	if p.b.keylessSecretStore == nil {
		return KeylessSecretTarget{}, false
	}
	return p.b.keylessSecretStore(ctx), true
}

// IsKeylessSecretStore reports whether a secrets slug is a cross-account keyless secret-manager
// provider (an ADDITIONAL foreign-account read source, not a native-store replacement). Cheap lookup
// for routing in Compose / DominantKeylessSecretTarget without building a full ComponentContext.
func IsKeylessSecretStore(slug string) bool {
	b, ok := behaviors["secrets/"+slug]
	return ok && b.keylessSecretStore != nil
}

// SaaSSecretStore returns the credential-based external secret store (Vault / OpenBao / Doppler /
// generic Vault-compatible) the ESO ClusterSecretStore reads with a static seeded token, or ok=false
// when the provider is not a runtime-read SaaS secret store. It replaces the native store as the
// project's secret source (unlike the keyless cross-account store, which is additive).
func (p *CategoryProvider) SaaSSecretStore(ctx ComponentContext) (SecretsSaaSStore, bool) {
	if p.b.saasSecretStore == nil {
		return SecretsSaaSStore{}, false
	}
	return p.b.saasSecretStore(ctx), true
}

// IsSaaSSecretStore reports whether a secrets slug is a credential-based external secret store with a
// first-class in-cluster ESO runtime-read path on the pinned chart (vault / generic / doppler /
// infisical). It is true only when saasSecretStore is registered — so 1Password (whose runtime-read
// is an explicit documented exclusion: ESO's provider is Connect-server-only, which no chart bump
// changes) returns false and renders no ClusterSecretStore. Cheap
// lookup for routing in DominantSecretsSaaSStore without building a full ComponentContext.
func IsSaaSSecretStore(slug string) bool {
	b, ok := behaviors["secrets/"+slug]
	return ok && b.saasSecretStore != nil
}

// RepoCred returns the ArgoCD repository credential a private Helm/OCI chart-repo connection maps to
// (helm_registry providers only). ok is false when the provider registered no repoCred — a
// non-helm_registry provider, or a coming_soon slug whose keyless resolution is a documented follow-up.
func (p *CategoryProvider) RepoCred(ctx ComponentContext) (RepoCred, bool) {
	if p.b.repoCred == nil {
		return RepoCred{}, false
	}
	return p.b.repoCred(ctx), true
}

// IsHelmRegistry reports whether a slug is a helm_registry provider with a seedable repo credential
// (true only when repoCred is set — so a coming_soon keyless slug returns false and is skipped by
// HelmRepoCredSpecs). Cheap lookup for routing without building a full ComponentContext.
func IsHelmRegistry(slug string) bool {
	b, ok := behaviors["helm_registry/"+slug]
	return ok && b.repoCred != nil
}

// KeylessRepoCred returns the cross-account keyless OCI Helm registry target (Amazon ECR / ECR Public),
// or ok=false when the provider is not a keyless helm registry. A keyless helm registry has no repoCred;
// its repo-cred Secret is minted + refreshed in-cluster by the `helm-repo-token` refresher.
func (p *CategoryProvider) KeylessRepoCred(ctx ComponentContext) (KeylessHelmRepoTarget, bool) {
	if p.b.keylessRepoCred == nil {
		return KeylessHelmRepoTarget{}, false
	}
	return p.b.keylessRepoCred(ctx), true
}

// IsKeylessHelmRegistry reports whether a helm_registry slug is a cross-account keyless provider (its
// repo-cred Secret is refreshed in-cluster, not seeded statically — the ECR case). Cheap lookup for
// routing in KeylessHelmRepoTargets / Compose without building a full ComponentContext.
func IsKeylessHelmRegistry(slug string) bool {
	b, ok := behaviors["helm_registry/"+slug]
	return ok && b.keylessRepoCred != nil
}

// Get resolves a provider by (category, slug). The slug must exist both in the
// catalog (declarative) and the behavior registry (impl) — otherwise it's a
// half-added provider and we fail loudly.
func Get(category, slug string) (*CategoryProvider, error) {
	key := category + "/" + slug
	meta, okMeta := metaIndex[key]
	if !okMeta {
		return nil, fmt.Errorf("unknown connector provider %q for category %q", slug, category)
	}
	b, okBehavior := behaviors[key]
	if !okBehavior {
		return nil, fmt.Errorf("connector provider %q has no registered behavior (impl missing)", key)
	}
	return &CategoryProvider{meta: meta, b: b}, nil
}

// IsPluggable reports whether a provider slug selects a non-cloud-native backend.
func IsPluggable(slug string) bool {
	return slug != "" && slug != "native"
}
