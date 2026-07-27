// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The cache offer's cloud-indifferent SIZE axis must reach every cloud.
//
// `ProjectCacheConfig.MemoryGB` is what the canvas offers as portable sizing, and until #1526 azure
// read no size at all: the only size-ish signal was `NumCacheNodes > 1` flipping the tier to
// "Standard". A size axis that lands on three clouds out of four is worse than none — it presents as
// coverage while being silently dropped on the cloud it misses. That is the cloud-parity rule, so it
// is asserted mechanically here rather than left to each provider's own test.
//
// The assertion is deliberately NOT "aws 12 GB is cache.t3.medium": pinning SKUs here would just
// duplicate packages/core/catalog/catalog.json and red on every catalog refresh. What has to hold is
// that the tfvar is emitted at all and that it MOVES with the size — the two properties a day-2
// resize depends on.
func TestCacheMemoryGBReachesEveryCloud(t *testing.T) {
	// The var each provider carries the resolved size on. gcp is the odd one out on purpose: it
	// passes MemoryGB through as a number rather than resolving a tier name (gcp_provider.go).
	clouds := []struct {
		name     string
		provider CloudProvider
		tfvar    string
	}{
		{"aws", &awsProvider{}, "redis_instance_type"},
		{"gcp", &gcpProvider{}, "memorystore_memory_size_gb"},
		{"azure", &azureProvider{}, "azure_cache_sku_name"},
		{"alibaba", &alibabaProvider{}, "kvstore_instance_class"},
	}

	for _, c := range clouds {
		t.Run(c.name, func(t *testing.T) {
			tfvars := func(memoryGB float64) map[string]interface{} {
				return c.provider.ProviderTfvars(&types.ProjectConfig{
					Caches: []types.ProjectCacheConfig{{Name: "c", MemoryGB: memoryGB}},
				})
			}

			small, big := tfvars(1), tfvars(12)
			if small[c.tfvar] == nil {
				t.Fatalf("%s: MemoryGB=1 emitted no %s — the size axis is dropped on this cloud", c.name, c.tfvar)
			}
			if big[c.tfvar] == nil {
				t.Fatalf("%s: MemoryGB=12 emitted no %s", c.name, c.tfvar)
			}
			if small[c.tfvar] == big[c.tfvar] {
				t.Errorf("%s: 1 GB and 12 GB both resolved to %s=%v — the axis is read but does not move",
					c.name, c.tfvar, small[c.tfvar])
			}
		})
	}
}

// A stale legacy NodeType must not shadow MemoryGB on azure — the abstract-first precedence
// resolveCacheNodeType applies for every other cloud (#1002), now that azure goes through it too.
func TestAzureCacheMemoryGBBeatsLegacyNodeType(t *testing.T) {
	tf := (&azureProvider{}).ProviderTfvars(&types.ProjectConfig{
		Caches: []types.ProjectCacheConfig{{
			Name:     "c",
			NodeType: "C1", // a retired Azure Cache for Redis capacity name
			MemoryGB: 12,
		}},
	})
	if got := tf["azure_cache_sku_name"]; got == "C1" {
		t.Fatalf("azure_cache_sku_name = %v — the legacy NodeType shadowed MemoryGB, and C1 is not a "+
			"sku azurerm_managed_redis accepts", got)
	}
	if tf["azure_cache_sku_name"] == nil {
		t.Fatal("azure_cache_sku_name was not emitted at all")
	}
}

// With no size given, azure must stay silent so the template's own default applies. Emitting a tier
// here would change the cost of every existing project that never chose one.
func TestAzureCacheEmitsNoSkuWithoutASize(t *testing.T) {
	tf := (&azureProvider{}).ProviderTfvars(&types.ProjectConfig{
		Caches: []types.ProjectCacheConfig{{Name: "c"}},
	})
	if got, ok := tf["azure_cache_sku_name"]; ok {
		t.Fatalf("azure_cache_sku_name = %v with no MemoryGB and no NodeType — want it absent", got)
	}
}
