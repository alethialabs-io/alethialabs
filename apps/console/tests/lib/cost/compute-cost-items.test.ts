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
import type { RegionPrices } from "@/lib/pricing/region-prices";

const META = {
	clusterService: "EKS",
	secretsService: "Secrets Manager",
	provider: "aws",
} as const;
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
		// No instance type → the AWS template's own default, which is the catalog's t3.large since
		// #5266 (FALLBACK_EC2 0.0912/h), × 2.
		expect(nodes?.cost).toBeCloseTo(0.0912 * 2 * HOURS, 5);
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

// #5251: an EMPTY instance list is what the template buys, not a cheap guess. The rates are written
// out (not read from TEMPLATE_DEFAULT_NODE) so a change to that table has to change this file too.
describe("computeCostItems — an empty instance list is priced at the cloud's template default", () => {
	it.each([
		["aws", "t3.large", 0.0912],
		["gcp", "e2-standard-2", 49 / 730],
		["azure", "Standard_D2s_v5", 70 / 730],
		["hetzner", "cpx22", 19 / 730],
		["alibaba", "ecs.g6.large", 50 / 730],
	] as const)("%s → %s", (provider, instanceType, hourly) => {
		const { items } = computeCostItems(input({ nodeDesiredSize: 2 }), null, {
			clusterService: "K8s",
			secretsService: "Secrets",
			provider,
		});
		const nodes = items.find((i) => i.label === "K8s Nodes");
		expect(nodes?.cost).toBeCloseTo(hourly * 2 * HOURS, 5);
		expect(nodes?.detail).toBe(`2x ${instanceType} (template default)`);
	});

	it("prices an empty list exactly as the catalog default it now provisions (#5266)", () => {
		const empty = computeCostItems(input({ nodeDesiredSize: 2 }), null, META);
		const asDefault = computeCostItems(
			input({ instanceTypes: ["t3.large"], nodeDesiredSize: 2 }),
			null,
			META,
		);
		const nodes = (r: typeof empty) => r.items.find((i) => i.label === "EKS Nodes")?.cost ?? 0;
		expect(nodes(empty)).toBeCloseTo(nodes(asDefault), 5);
	});

	it("prefers a live price for the template default over the fallback", () => {
		const prices: RegionPrices = {
			eksControlPlane: 0.1,
			ec2: { "t3.large": 0.5 },
			natGateway: 0.048,
			auroraACU: 0.14,
			cache: {},
			wafWebACL: 5,
			region: "us-east-1",
			fetchedAt: "2026-10-01T00:00:00Z",
		};
		const { items } = computeCostItems(input({ nodeDesiredSize: 1 }), prices, META);
		expect(items.find((i) => i.label === "EKS Nodes")?.cost).toBeCloseTo(0.5 * HOURS, 5);
	});

	it("still prices an explicit instance type, not the template default", () => {
		const { items } = computeCostItems(
			input({ instanceTypes: ["t3.large"], nodeDesiredSize: 1 }),
			null,
			{ ...META, provider: "hetzner" },
		);
		expect(items.find((i) => i.label === "EKS Nodes")?.cost).toBeCloseTo(0.0912 * HOURS, 5);
	});
});

// #5291: a node_size cluster used to be priced from instance_types alone, so `instance_types: []`
// plus a size was priced at the template default while the card named the resolved SKU. The SKUs
// and rates are written out BY DECISION from catalog.json (an expectation recomputed with
// nearestInstance would pass on any answer): aws 4×16 → t3.xlarge (0.1824/h, the fallback table),
// gcp 4×16 → e2-standard-4 (catalog hint ~$98/mo).
describe("computeCostItems — a node_size cluster is priced at the SKU it resolves to (#5291)", () => {
	const size = { vcpu: 4, memory_gb: 16 };
	const nodes = (r: ReturnType<typeof computeCostItems>) =>
		r.items.find((i) => i.label.endsWith(" Nodes"));

	it("aws: 4 vCPU / 16 GB is priced as a t3.xlarge, not the t3.large default", () => {
		const r = computeCostItems(input({ nodeSize: size, nodeDesiredSize: 2 }), null, META);
		expect(nodes(r)?.cost).toBeCloseTo(0.1824 * 2 * HOURS, 5);
		expect(nodes(r)?.detail).toBe("2x 4 vCPU / 16 GB → t3.xlarge");
	});

	it("gcp: 4 vCPU / 16 GB is priced as an e2-standard-4 at the catalog's rate", () => {
		const r = computeCostItems(input({ nodeSize: size, nodeDesiredSize: 3 }), null, {
			...META,
			provider: "gcp",
		});
		expect(nodes(r)?.cost).toBeCloseTo((98 / HOURS) * 3 * HOURS, 5);
		expect(nodes(r)?.detail).toBe("3x 4 vCPU / 16 GB → e2-standard-4");
	});

	it("a pinned type still wins over a size the row also holds (Go's precedence)", () => {
		const r = computeCostItems(
			input({ instanceTypes: ["m5a.large"], nodeSize: size, nodeDesiredSize: 1 }),
			null,
			META,
		);
		expect(nodes(r)?.cost).toBeCloseTo(0.096 * HOURS, 5);
		expect(nodes(r)?.detail).toBe("1x m5a.large");
	});

	it("a Spot pool is said to be estimated on-demand, at the on-demand rate", () => {
		const r = computeCostItems(
			input({ nodeSize: size, nodeDesiredSize: 1, capacityType: "spot" }),
			null,
			META,
		);
		expect(nodes(r)?.cost).toBeCloseTo(0.1824 * HOURS, 5);
		expect(nodes(r)?.detail).toBe(
			"1x 4 vCPU / 16 GB → t3.xlarge · Spot, estimated at on-demand rates",
		);
		const onDemand = computeCostItems(
			input({ nodeSize: size, nodeDesiredSize: 1, capacityType: "on_demand" }),
			null,
			META,
		);
		expect(nodes(onDemand)?.detail).toBe("1x 4 vCPU / 16 GB → t3.xlarge");
	});
});
