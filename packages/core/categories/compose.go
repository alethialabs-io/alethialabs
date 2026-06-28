// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Compose wires pluggable category providers into a prepared OpenTofu working
// directory. For each component whose provider is non-native it: validates the
// selection, copies the provider's module into workDir/categories/<cat>/<slug>,
// merges its tfvars into the shared map, and records a module block. It always
// sets the native-guard vars (dns_provider / secrets_provider / registry_provider)
// so the cluster-cloud templates can skip the native resource. Finally it writes
// workDir/_categories.tf.json (OpenTofu reads .tf.json natively) with the module
// blocks. Returns the number of modules composed.
//
// MVP note: secrets and registries are assumed homogeneous per project — if any item
// selects a pluggable provider, that provider handles the whole category and a
// warning is logged for any mixed selection.
func Compose(
	workDir, categoriesSrcDir string,
	vc *types.ProjectConfig,
	tfvars map[string]any,
	log io.Writer,
) (int, error) {
	// Default guards to native so the cloud templates create native resources.
	tfvars["dns_provider"] = "native"
	tfvars["secrets_provider"] = "native"
	tfvars["registry_provider"] = "native"

	modules := map[string]map[string]any{}

	add := func(name string, p *CategoryProvider, ctx ComponentContext) error {
		if err := p.Validate(ctx); err != nil {
			return fmt.Errorf("%s/%s validation failed: %w", p.Category(), p.Slug(), err)
		}
		if categoriesSrcDir != "" {
			src := filepath.Join(categoriesSrcDir, relModulePath(p.ModulePath()))
			dst := filepath.Join(workDir, "categories", p.Category(), p.Slug())
			if err := copyTree(src, dst); err != nil {
				return fmt.Errorf("failed to copy %s module: %w", p.Slug(), err)
			}
		}
		block := map[string]any{
			"source": "./categories/" + p.Category() + "/" + p.Slug(),
		}
		for k, v := range p.Tfvars(ctx) {
			block[k] = v
		}
		modules[name] = block
		fmt.Fprintf(log, "Composed %s provider: %s (module %s)\n", p.Category(), p.Slug(), p.ModulePath())
		return nil
	}

	// ── DNS (singleton) ──
	if vc.DNS.Enabled && IsPluggable(vc.DNS.Provider) {
		p, err := Get("dns", vc.DNS.Provider)
		if err != nil {
			return 0, err
		}
		ctx := ComponentContext{
			Project:        vc,
			Credentials:    vc.ConnectorCredentialFor("dns", vc.DNS.Provider),
			ProviderConfig: vc.DNS.ProviderConfig,
		}
		if err := add("dns", p, ctx); err != nil {
			return 0, err
		}
		tfvars["dns_provider"] = vc.DNS.Provider
	}

	// ── Observability (singleton) ──
	if vc.Observability.Enabled && IsPluggable(vc.Observability.Provider) {
		p, err := Get("observability", vc.Observability.Provider)
		if err != nil {
			return 0, err
		}
		ctx := ComponentContext{
			Project:        vc,
			Credentials:    vc.ConnectorCredentialFor("observability", vc.Observability.Provider),
			ProviderConfig: vc.Observability.ProviderConfig,
		}
		if err := add("observability", p, ctx); err != nil {
			return 0, err
		}
	}

	// ── Secrets (multi → homogeneous) ──
	if slug, items := dominantProvider(secretItems(vc), log, "secrets"); IsPluggable(slug) {
		p, err := Get("secrets", slug)
		if err != nil {
			return 0, err
		}
		ctx := ComponentContext{
			Project:     vc,
			Credentials: vc.ConnectorCredentialFor("secrets", slug),
			Items:       items,
		}
		if err := add("secrets", p, ctx); err != nil {
			return 0, err
		}
		tfvars["secrets_provider"] = slug
	}

	// ── Container registries (multi → homogeneous) ──
	if slug, items := dominantProvider(registryItems(vc), log, "registry"); IsPluggable(slug) {
		p, err := Get("registry", slug)
		if err != nil {
			return 0, err
		}
		ctx := ComponentContext{
			Project:     vc,
			Credentials: vc.ConnectorCredentialFor("registry", slug),
			Items:       items,
		}
		if err := add("registry", p, ctx); err != nil {
			return 0, err
		}
		tfvars["registry_provider"] = slug
	}

	if len(modules) == 0 {
		return 0, nil
	}

	doc := map[string]any{"module": modules}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return 0, fmt.Errorf("failed to encode _categories.tf.json: %w", err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "_categories.tf.json"), append(data, '\n'), 0644); err != nil {
		return 0, fmt.Errorf("failed to write _categories.tf.json: %w", err)
	}
	return len(modules), nil
}

// providerItem pairs a component's provider slug with its module item.
type providerItem struct {
	provider string
	item     ComponentItem
}

func secretItems(vc *types.ProjectConfig) []providerItem {
	out := make([]providerItem, 0, len(vc.Secrets))
	for _, s := range vc.Secrets {
		out = append(out, providerItem{
			provider: s.Provider,
			item:     ComponentItem{Name: s.Name, ProviderConfig: s.ProviderConfig},
		})
	}
	return out
}

func registryItems(vc *types.ProjectConfig) []providerItem {
	out := make([]providerItem, 0, len(vc.ContainerRegistries))
	for _, r := range vc.ContainerRegistries {
		out = append(out, providerItem{
			provider: r.Provider,
			item:     ComponentItem{Name: r.Name, ProviderConfig: r.ProviderConfig},
		})
	}
	return out
}

// dominantProvider picks the single pluggable provider for a homogeneous-MVP
// category and returns its items. Logs a warning if selections are mixed.
func dominantProvider(items []providerItem, log io.Writer, category string) (string, []ComponentItem) {
	chosen := ""
	for _, it := range items {
		if IsPluggable(it.provider) {
			if chosen == "" {
				chosen = it.provider
			} else if chosen != it.provider {
				fmt.Fprintf(log, "Warning: mixed %s providers selected (%s, %s) — using %s for all (MVP limitation).\n",
					category, chosen, it.provider, chosen)
			}
		}
	}
	if chosen == "" {
		return "", nil
	}
	out := make([]ComponentItem, 0, len(items))
	for _, it := range items {
		out = append(out, it.item)
	}
	return chosen, out
}

// relModulePath strips the leading "categories/" from a catalog module_path,
// since Compose joins it under the categories source root.
func relModulePath(modulePath string) string {
	const prefix = "categories/"
	if len(modulePath) > len(prefix) && modulePath[:len(prefix)] == prefix {
		return modulePath[len(prefix):]
	}
	return modulePath
}

// copyTree recursively copies src → dst (used to vendor a module into the work dir).
func copyTree(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("module path is not a directory: %s", src)
	}
	return filepath.Walk(src, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, fi.Mode())
	})
}
