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
