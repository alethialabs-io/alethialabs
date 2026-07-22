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
