// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The capabilities server action — the one client-reachable door to the per-tenant catalog.
//
// What's pinned here is mostly about what the action REFUSES to do: trust a caller-supplied
// provider, read region-scoped axes without a region, or claim account provenance it doesn't have.
// Each of those fails silently in the product (wrong cloud's SKUs, a false "launchable", a green
// footnote over catalog data) rather than throwing, so they need a test rather than a reviewer.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	identity: [{ provider: "aws", syncedAt: null as Date | null }],
	regionCalls: [] as unknown[][],
	instanceCalls: [] as unknown[][],
	cacheCalls: [] as unknown[][],
}));

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ userId: "u1", orgId: "org-1" })),
}));

vi.mock("@/lib/db", () => ({
	withActorScope: vi.fn(async (_a: unknown, fn: (tx: unknown) => unknown) => {
		const chain: Record<string, (...a: unknown[]) => unknown> = {};
		for (const m of ["select", "from", "where"]) chain[m] = () => chain;
		chain.limit = () => Promise.resolve(state.identity);
		return fn(chain);
	}),
}));

vi.mock("@/lib/queries/capabilities", () => ({
	getRegionCapabilities: vi.fn(async (...a: unknown[]) => {
		state.regionCalls.push(a);
		return { codes: ["eu-west-1"], source: "account" as const };
	}),
	getInstanceTypeCapabilities: vi.fn(async (...a: unknown[]) => {
		state.instanceCalls.push(a);
		return [
			{ value: "m5.large", label: "m5.large", vcpu: 2, memoryGb: 8, launchable: "launchable" },
		];
	}),
	getK8sVersionCapabilities: vi.fn(async () => [{ version: "1.35" }]),
	getDatabaseCapabilities: vi.fn(async () => ({ engines: [], capacity: {} })),
	getCacheTierCapabilities: vi.fn(async (...a: unknown[]) => {
		state.cacheCalls.push(a);
		return [];
	}),
	getNosqlCapability: vi.fn(async () => ({
		serviceName: "DynamoDB",
		available: true,
		config: { keyTypes: [{ value: "S", label: "String" }] },
	})),
}));

vi.mock("@/app/server/actions/cloud-resources", () => ({
	getCloudIdentityInventory: vi.fn(async () => ({
		networks: [
			{
				id: "row-1",
				native_id: "vpc-abc",
				name: "prod",
				region: "eu-west-1",
				cidr_block: "10.0.0.0/16",
				is_default: true,
			},
		],
		subnets: [
			{
				id: "row-2",
				native_id: "subnet-1",
				name: "a",
				region: "eu-west-1",
				cidr_block: "10.0.1.0/24",
				availability_zone: "eu-west-1a",
				is_public: true,
				network_id: "row-1",
			},
		],
		regions: [],
	})),
}));

import { getIdentityCapabilities } from "@/app/server/actions/capabilities";
import { authorize } from "@/lib/authz/guard";

beforeEach(() => {
	state.identity = [{ provider: "aws", syncedAt: null }];
	state.regionCalls = [];
	state.instanceCalls = [];
	state.cacheCalls = [];
	vi.clearAllMocks();
});

describe("getIdentityCapabilities", () => {
	it("PDP-gates the read on the cloud_identity", async () => {
		await getIdentityCapabilities("ci-1", "eu-west-1");
		expect(authorize).toHaveBeenCalledWith("view", {
			type: "cloud_identity",
			id: "ci-1",
		});
	});

	it("derives the provider from the identity — never from the caller", async () => {
		// The action takes no provider argument at all. Every reader filters on provider, so a
		// caller-supplied one would return zero rows and then fail open to THAT cloud's static
		// catalog — an AWS project rendering GCP machine types.
		await getIdentityCapabilities("ci-1", "eu-west-1");
		expect(state.regionCalls[0]?.[1]).toBe("aws");
		expect(state.instanceCalls[0]?.[1]).toBe("aws");
	});

	it("returns the empty bag for a cloud with no option catalog", async () => {
		state.identity = [{ provider: "digitalocean", syncedAt: null }];
		const bag = await getIdentityCapabilities("ci-1", "nyc3");
		expect(bag.provider).toBeNull();
		expect(bag.regions).toEqual([]);
		expect(state.instanceCalls).toHaveLength(0);
	});

	it("SKIPS region-scoped axes when no region is given", async () => {
		// A region-less instance-type read returns the union across regions, so a type launchable
		// only in eu-central-1 would show as launchable in us-east-1. No signal beats a false one.
		const bag = await getIdentityCapabilities("ci-1", null);
		expect(state.instanceCalls).toHaveLength(0);
		expect(state.cacheCalls).toHaveLength(0);
		expect(bag.instanceTypes).toEqual([]);
		expect(bag.axisSource.instance_type).toBe("catalog");
		expect(bag.axisSource.cache_tier).toBe("catalog");
	});

	it("reports per-axis provenance honestly", async () => {
		const bag = await getIdentityCapabilities("ci-1", "eu-west-1");
		expect(bag.axisSource.region).toBe("account"); // the reader said so
		expect(bag.axisSource.instance_type).toBe("account"); // rows carry a launchable verdict
		// k8s rows came back WITHOUT a verdict → a static fallback, not account data.
		expect(bag.axisSource.k8s_version).toBe("catalog");
	});

	it("maps placement inventory onto NATIVE ids and resolves the subnet's parent", async () => {
		// project_network.network_id stores `vpc-…`; the subnet's FK is the cloud_networks ROW id,
		// so it has to be resolved back to a native id for the picker to match on.
		const bag = await getIdentityCapabilities("ci-1", "eu-west-1");
		expect(bag.networks[0].nativeId).toBe("vpc-abc");
		expect(bag.subnets[0].networkRowId).toBe("vpc-abc");
	});

	describe("sync state (the honest heuristic)", () => {
		// claimDueCapability stamps capabilities_synced_at BEFORE enumerating, so rows=0 with a recent
		// stamp is genuinely ambiguous between "still running" and "produced nothing". The window is
		// an approximation and is documented as one — these pin which way each case falls.
		beforeEach(async () => {
			const q = await import("@/lib/queries/capabilities");
			vi.mocked(q.getRegionCapabilities).mockResolvedValue({
				codes: ["us-east-1"],
				source: "catalog",
			});
			vi.mocked(q.getK8sVersionCapabilities).mockResolvedValue([{ version: "1.35" }]);
		});

		it("never synced (no stamp, no rows) reads as syncing", async () => {
			state.identity = [{ provider: "aws", syncedAt: null }];
			expect((await getIdentityCapabilities("ci-1", null)).state).toBe("syncing");
		});

		it("a stamp inside the window with no rows still reads as syncing", async () => {
			state.identity = [{ provider: "aws", syncedAt: new Date(Date.now() - 60_000) }];
			expect((await getIdentityCapabilities("ci-1", null)).state).toBe("syncing");
		});

		it("an old stamp with no rows reads as ready — the account genuinely reported nothing", async () => {
			state.identity = [{ provider: "aws", syncedAt: new Date(Date.now() - 3_600_000) }];
			expect((await getIdentityCapabilities("ci-1", null)).state).toBe("ready");
		});

		it("any account rows win over the stamp heuristic", async () => {
			const q = await import("@/lib/queries/capabilities");
			vi.mocked(q.getRegionCapabilities).mockResolvedValue({
				codes: ["eu-west-1"],
				source: "account",
			});
			state.identity = [{ provider: "aws", syncedAt: null }];
			expect((await getIdentityCapabilities("ci-1", null)).state).toBe("ready");
		});
	});
});
