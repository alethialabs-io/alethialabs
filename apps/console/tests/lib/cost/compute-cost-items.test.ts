// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces the deleted tests/components/cost-preview.test.ts, which re-implemented a FAKE
// calculateCost() inline and never touched real code (≈0 mutation score). This drives the REAL
// estimator, lib/cost/compute-cost-items.ts → computeCostItems, with prices=null (fallback rates).

import { describe, expect, it } from "vitest";
import {
	computeCostItems,
	type CostInput,
} from "@/lib/cost/compute-cost-items";

const META = { clusterService: "EKS", secretsService: "Secrets Manager" };
const HOURS = 730;

/** Minimal valid input; override per case. */
function input(over: Partial<CostInput> = {}): CostInput {
	return {
		instanceTypes: [],
		nodeDesiredSize: 2,
		singleNatGateway: true,
		databases: [],
		caches: [],
		cloudfrontWaf: false,
		applicationWaf: false,
		nosqlCount: 0,
		secretsCount: 0,
		...over,
	};
}

describe("computeCostItems (fallback prices)", () => {
	it("computes control-plane + nodes + NAT with hardcoded rates", () => {
		const { items, total } = computeCostItems(input(), null, META);
		expect(items).toHaveLength(3);
		const cp = items.find((i) => i.label === "EKS Control Plane");
		expect(cp?.cost).toBeCloseTo(0.1 * HOURS, 5); // 73
		const nodes = items.find((i) => i.label === "EKS Nodes");
		expect(nodes?.cost).toBeCloseTo(0.0456 * 2 * HOURS, 5); // default EC2 rate × 2 nodes
		const nat = items.find((i) => i.label === "NAT Gateway");
		expect(nat?.cost).toBeCloseTo(0.048 * HOURS, 5);
		expect(total).toBeCloseTo(items.reduce((s, i) => s + i.cost, 0), 5);
	});

	it("triples the NAT cost for per-AZ gateways", () => {
		const single = computeCostItems(input({ singleNatGateway: true }), null, META);
		const perAz = computeCostItems(input({ singleNatGateway: false }), null, META);
		const natSingle = single.items.find((i) => i.label === "NAT Gateway")?.cost ?? 0;
		const natPerAz = perAz.items.find((i) => i.label === "NAT Gateway")?.cost ?? 0;
		expect(natPerAz).toBeCloseTo(natSingle * 3, 5);
		expect(perAz.items.find((i) => i.label === "NAT Gateway")?.detail).toBe("per-AZ");
	});

	it("adds a line per database using min_capacity × ACU rate", () => {
		const { items } = computeCostItems(
			input({ databases: [{ name: "main", min_capacity: 2, max_capacity: 8 }] }),
			null,
			META,
		);
		const db = items.find((i) => i.label === "DB: main");
		expect(db?.cost).toBeCloseTo(2 * 0.14 * HOURS, 5);
		expect(db?.detail).toBe("2-8 ACU");
	});

	it("adds WAF and secrets line items", () => {
		const { items } = computeCostItems(
			input({ cloudfrontWaf: true, applicationWaf: true, secretsCount: 3 }),
			null,
			META,
		);
		expect(items.find((i) => i.label === "CDN WAF")?.cost).toBe(5);
		expect(items.find((i) => i.label === "Application WAF")?.cost).toBe(5);
		expect(items.find((i) => i.label === "Secrets Manager")?.cost).toBeCloseTo(3 * 0.4, 5);
	});

	it("prices nodes from the fallback EC2 table for the chosen instance type", () => {
		// prices=null → must use FALLBACK_EC2["t3.large"] = 0.0912 (not the generic 0.0456).
		const { items } = computeCostItems(
			input({ instanceTypes: ["t3.large"], nodeDesiredSize: 1 }),
			null,
			META,
		);
		const nodes = items.find((i) => i.label === "EKS Nodes");
		expect(nodes?.cost).toBeCloseTo(0.0912 * 1 * HOURS, 4);
		expect(nodes?.detail).toBe("1x t3.large");
	});

	it("labels multi-instance node pools with a +N suffix", () => {
		const { items } = computeCostItems(
			input({ instanceTypes: ["t3.medium", "t3.large"], nodeDesiredSize: 3 }),
			null,
			META,
		);
		expect(items.find((i) => i.label === "EKS Nodes")?.detail).toBe("3x t3.medium +1");
	});

	it("prices caches from the fallback cache table", () => {
		const { items } = computeCostItems(
			input({ caches: [{ name: "r", node_type: "cache.t3.medium", num_cache_nodes: 2 }] }),
			null,
			META,
		);
		// FALLBACK_CACHE["cache.t3.medium"] = 0.058 × 2 nodes × 730.
		expect(items.find((i) => i.label === "Cache: r")?.cost).toBeCloseTo(0.058 * 2 * HOURS, 4);
	});

	it("adds a zero-cost on-demand line for NoSQL tables", () => {
		const { items } = computeCostItems(input({ nosqlCount: 2 }), null, META);
		const nosql = items.find((i) => i.label === "NoSQL");
		expect(nosql?.cost).toBe(0);
		expect(nosql?.detail).toBe("2 tables (on-demand)");
	});

	it("honors live prices over the fallbacks when provided", () => {
		const prices = {
			eksControlPlane: 0.2,
			ec2: {},
			natGateway: 0.1,
			auroraACU: 0.2,
			cache: {},
			wafWebACL: 9,
		} as never;
		const { items } = computeCostItems(input(), prices, META);
		expect(items.find((i) => i.label === "EKS Control Plane")?.cost).toBeCloseTo(0.2 * HOURS, 4);
		expect(items.find((i) => i.label === "NAT Gateway")?.cost).toBeCloseTo(0.1 * HOURS, 4);
	});

	it("keeps total equal to the sum of item costs (invariant)", () => {
		const { items, total } = computeCostItems(
			input({
				instanceTypes: ["t3.large"],
				nodeDesiredSize: 3,
				databases: [{ name: "db", min_capacity: 4 }],
				caches: [{ name: "redis", node_type: "cache.t3.medium", num_cache_nodes: 2 }],
				cloudfrontWaf: true,
			}),
			null,
			META,
		);
		expect(total).toBeCloseTo(items.reduce((s, i) => s + i.cost, 0), 5);
		expect(total).toBeGreaterThan(0);
	});
});
