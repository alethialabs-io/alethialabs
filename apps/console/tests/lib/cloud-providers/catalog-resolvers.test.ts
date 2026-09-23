// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The generated catalog's lookup helpers. They mirror the Go resolver, and nothing exercised them:
// the directory's coverage was carried by the data, not by the behaviour. Each assertion checks a
// PROPERTY of the answer (exact match wins, the family is honoured, the pick is no farther than any
// candidate) rather than re-computing the expected value with the same formula under test.

import { describe, expect, it } from "vitest";
import {
	CATALOG,
	cacheTiers,
	listInstances,
	nearestCacheTier,
	nearestInstance,
	providerMeta,
	resolveRegion,
} from "@/lib/cloud-providers/generated/catalog";

describe("providerMeta", () => {
	it("finds a listed provider by slug and nothing for an unknown one", () => {
		expect(providerMeta("aws")?.slug).toBe("aws");
		expect(providerMeta("no-such-cloud")).toBeUndefined();
	});
});

describe("resolveRegion", () => {
	it("maps a canonical region to each provider's own code, and an unknown id to nothing", () => {
		const region = CATALOG.regions.find((r) => Object.keys(r.codes).length > 0);
		expect(region).toBeDefined();
		if (!region) return;
		for (const [provider, code] of Object.entries(region.codes)) {
			expect(resolveRegion(region.id, provider)).toBe(code);
		}
		expect(resolveRegion("no-such-region", "aws")).toBeUndefined();
		expect(resolveRegion(region.id, "no-such-cloud")).toBeUndefined();
	});
});

describe("nearestInstance", () => {
	const instances = listInstances("aws");

	it("has an inventory to test against", () => {
		expect(instances.length).toBeGreaterThan(1);
	});

	it("returns an exact-shape instance when one exists", () => {
		const target = instances[instances.length - 1];
		const got = nearestInstance("aws", target.vcpu, target.memory_gb);
		expect(got?.vcpu).toBe(target.vcpu);
		expect(got?.memory_gb).toBe(target.memory_gb);
	});

	it("never picks a candidate farther away than another one", () => {
		const got = nearestInstance("aws", 3, 7);
		expect(got).toBeDefined();
		if (!got) return;
		const dist = (v: number, m: number) => Math.hypot(v - 3, m - 7);
		for (const i of instances) {
			expect(dist(got.vcpu, got.memory_gb)).toBeLessThanOrEqual(dist(i.vcpu, i.memory_gb));
		}
	});

	it("stays inside the requested family even when another family is closer", () => {
		const families = [...new Set(instances.map((i) => i.family))];
		expect(families.length).toBeGreaterThan(1);
		const family = families[families.length - 1];
		expect(nearestInstance("aws", 1, 1, family)?.family).toBe(family);
	});

	it("falls back to the whole inventory for an unknown family, and to nothing for an unknown cloud", () => {
		expect(nearestInstance("aws", 2, 4, "no-such-family")).toBeDefined();
		expect(nearestInstance("no-such-cloud", 2, 4)).toBeUndefined();
	});
});

describe("nearestCacheTier", () => {
	it("returns the exact-memory tier when one exists, and nothing for an unknown cloud", () => {
		const tiers = cacheTiers("aws");
		expect(tiers.length).toBeGreaterThan(0);
		const target = tiers[tiers.length - 1];
		expect(nearestCacheTier("aws", target.memory_gb)?.memory_gb).toBe(target.memory_gb);
		expect(nearestCacheTier("no-such-cloud", 1)).toBeUndefined();
	});

	it("never picks a tier farther from the requested memory than another one", () => {
		const got = nearestCacheTier("aws", 5);
		expect(got).toBeDefined();
		if (!got) return;
		for (const t of cacheTiers("aws")) {
			expect(Math.abs(got.memory_gb - 5)).toBeLessThanOrEqual(Math.abs(t.memory_gb - 5));
		}
	});
});
