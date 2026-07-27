// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cache SKU the canvas hands a user must be one the cloud can actually build (#1577).
//
// The sibling of engine-floor.test.ts, one axis over. `cache.<p>.tiers` is what the Go resolver
// picks from (NearestCacheTier) and what the tofu templates validate against; `DEFAULT_CACHE_NODE`
// and `CACHE_NODE_TYPES` are what the canvas stamps on a new node and offers in the picker. When
// azure moved to Managed Redis only the first was updated, so every azure cache node was created
// carrying the retired `C1` — and because `memory_gb` has no default, `resolveCacheNodeType` passed
// that `node_type` straight through to `azure_cache_sku_name`, which the template's sku validation
// rejects. The canvas offered something that could not be provisioned, and no test said so.
//
// gen-catalog.mjs now enforces this on the JSON at generate time. These assert it on the surface the
// canvas actually imports, so the guarantee survives a change to how the mirror is emitted.

import { describe, expect, it } from "vitest";
import {
	CACHE_NODE_MAP,
	CACHE_NODE_TYPES,
	DEFAULT_CACHE_NODE,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { cacheTiers } from "@/lib/cloud-providers/generated/catalog";

const CLOUDS = Object.keys(CACHE_NODE_TYPES) as CloudProviderSlug[];

/** The sku names `cache.<provider>.tiers` declares — the one value space the resolver and the
 * templates share. */
function buildableSkus(provider: CloudProviderSlug): string[] {
	return cacheTiers(provider).map((t) => t.value);
}

describe("every cache sku the canvas hands out is buildable", () => {
	it("covers every cloud with a managed cache catalog", () => {
		// A guard that silently stopped iterating would pass forever. Pin the set it walks.
		expect(CLOUDS.sort()).toEqual(["alibaba", "aws", "azure", "gcp", "hetzner"]);
	});

	it.each(CLOUDS)("%s: the default node type is a real tier", (cloud) => {
		// This is the one that broke: node-registry's defaultData stamps DEFAULT_CACHE_NODE onto every
		// cache node, and memory_gb is left unset, so this value IS the sku the plan emits.
		expect(buildableSkus(cloud)).toContain(DEFAULT_CACHE_NODE[cloud]);
	});

	it.each(CLOUDS)("%s: every picker fallback option is a real tier", (cloud) => {
		// CACHE_NODE_TYPES is the fail-open list behind getCacheTierCapabilities and cacheTierOptions —
		// what a user sees on any account that has not synced a cloud-capabilities pass yet, which is
		// the common case, not the edge one. A curated subset is fine; a different value space is not.
		const skus = buildableSkus(cloud);
		for (const option of CACHE_NODE_TYPES[cloud]) {
			expect(skus).toContain(option.value);
		}
	});

	it("the cross-cloud conversion map speaks both clouds' sku names", () => {
		// convert.ts rewrites node_type through this map when a project changes cloud, so a stale entry
		// produces the same unbuildable plan by a different route.
		for (const source of CLOUDS) {
			for (const target of CLOUDS) {
				const mapping = CACHE_NODE_MAP[source]?.[target] ?? {};
				expect({
					source,
					target,
					keys: Object.keys(mapping).filter((k) => !buildableSkus(source).includes(k)),
					values: Object.values(mapping).filter((v) => !buildableSkus(target).includes(v)),
				}).toEqual({ source, target, keys: [], values: [] });
			}
		}
	});
});

describe("azure names Managed Redis skus, not the retired Azure Cache for Redis ones", () => {
	// Belt and braces on the specific regression: azurerm_managed_redis validates sku_name with this
	// exact expression (infra/templates/project/azure/modules/azure-cache-redis/variables.tf), so a
	// Basic/Standard/Premium C*/P* name is not merely stale — it fails at plan.
	const MANAGED_REDIS_SKU = /^(Balanced_B|MemoryOptimized_M|ComputeOptimized_X|FlashOptimized_A)[0-9]+$/;

	it("the default, the picker fallback and the conversion targets all match the template", () => {
		expect(DEFAULT_CACHE_NODE.azure).toMatch(MANAGED_REDIS_SKU);
		for (const option of CACHE_NODE_TYPES.azure) {
			expect(option.value).toMatch(MANAGED_REDIS_SKU);
		}
		for (const source of CLOUDS) {
			for (const sku of Object.values(CACHE_NODE_MAP[source]?.azure ?? {})) {
				expect(sku).toMatch(MANAGED_REDIS_SKU);
			}
		}
	});
});
