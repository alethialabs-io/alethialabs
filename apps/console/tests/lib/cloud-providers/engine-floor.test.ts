// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-cloud engine floor, now derived from the catalog rather than hardcoded (#1420).
//
// It used to be a Hetzner carve-out in two unrelated places — the canvas floor and the cross-cloud
// converter — which was fine while Hetzner was the only cloud with an engine ceiling. It isn't:
// Azure Managed Redis and ApsaraDB KVStore have no Valkey, so the canvas was offering an engine
// those clouds cannot build. That is the #1382 shape on a second axis, and these pin the fix.

import { describe, expect, it } from "vitest";
import { variantOptionsFor } from "@/components/design-project/canvas/graph/node-registry";
import { cacheEngines, dbEngines } from "@/lib/cloud-providers/generated/catalog";

describe("variantOptionsFor — the canvas only offers engines the cloud can back", () => {
	it("hides Valkey on the clouds with no Valkey product", () => {
		// Verified against the pinned providers: azurerm exposes azurerm_managed_redis (Redis only),
		// and alicloud_kvstore_instance.instance_type accepts Redis or Memcache — never Valkey.
		for (const cloud of ["azure", "alibaba"] as const) {
			const values = variantOptionsFor("cache", cloud).map((o) => o.value);
			expect(values).toContain("redis");
			expect(values).not.toContain("valkey");
		}
	});

	it("offers both engines where both exist", () => {
		for (const cloud of ["aws", "gcp"] as const) {
			const values = variantOptionsFor("cache", cloud).map((o) => o.value);
			expect(values.sort()).toEqual(["redis", "valkey"]);
		}
	});

	it("keeps the Hetzner ceilings it always had — now from the same source", () => {
		expect(variantOptionsFor("cache", "hetzner").map((o) => o.value)).toEqual(["valkey"]);
		expect(variantOptionsFor("database", "hetzner").map((o) => o.value)).toEqual(["postgres"]);
	});

	it("offers everything when no provider is resolved yet", () => {
		// The create flow has no identity until one is picked; an empty picker there would be a #918
		// violation rather than an honest narrowing.
		expect(variantOptionsFor("cache", null).length).toBeGreaterThan(1);
	});

	it("derives from the catalog, not from a copy of it", () => {
		// If someone adds an engine to catalog.json the floor must follow with no code change. This
		// asserts the relationship rather than the current values, which the cases above already pin.
		for (const cloud of ["aws", "gcp", "azure", "alibaba", "hetzner"] as const) {
			expect(variantOptionsFor("cache", cloud).map((o) => o.value).sort()).toEqual(
				cacheEngines(cloud).map((e) => e.value).sort(),
			);
			const families = [...new Set(dbEngines(cloud).map((e) => e.family))].sort();
			expect(variantOptionsFor("database", cloud).map((o) => o.value).sort()).toEqual(families);
		}
	});
});
