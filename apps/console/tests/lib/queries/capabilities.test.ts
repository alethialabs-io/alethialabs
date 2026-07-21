// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the capabilities read builder (epic #928). Proves the two behaviours the seams
// guarantees: (1) PDP-gated + scoped reads, (2) FAIL-OPEN to the static Catalog #2 when the account has
// no synced rows, and that account-accurate rows (incl. the tri-state launchable guidance) override the
// fallback. Cross-tenant RLS itself is proven by the real-Postgres integration suite (rls.test.ts /
// org-visibility.test.ts); here withActorScope is mocked to a fake tx so we test the builder's logic.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorize } from "@/lib/authz/guard";
import { INSTANCE_TYPES } from "@/lib/cloud-providers/compute";
import { REGION_LABELS } from "@/lib/cloud-providers/regions";
import {
	getInstanceTypeCapabilities,
	getRegionCapabilities,
} from "@/lib/queries/capabilities";

// Shared mutable "DB rows" the fake tx resolves to (hoisted so the vi.mock factory can close over it).
const state = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ userId: "user-1", orgId: "user-1" })),
}));

vi.mock("@/lib/db", () => ({
	// Ignore the query shape — every terminal `.orderBy()` resolves to the preset rows.
	withActorScope: vi.fn(
		async (_actor: unknown, fn: (tx: unknown) => unknown) => {
			const chain: Record<string, (...a: unknown[]) => unknown> = {};
			chain.select = () => chain;
			chain.from = () => chain;
			chain.where = () => chain;
			chain.orderBy = () => Promise.resolve(state.rows);
			return fn(chain);
		},
	),
}));

beforeEach(() => {
	state.rows = [];
	vi.clearAllMocks();
});

describe("getRegionCapabilities", () => {
	it("PDP-gates the read on the cloud_identity", async () => {
		await getRegionCapabilities("ci-1", "aws");
		expect(authorize).toHaveBeenCalledWith("view", {
			type: "cloud_identity",
			id: "ci-1",
		});
	});

	it("fails open to the static Catalog #2 region set when nothing has synced", async () => {
		state.rows = [];
		const regions = await getRegionCapabilities("ci-1", "aws");
		expect(regions).toEqual(Object.keys(REGION_LABELS.aws));
		expect(regions).toContain("us-east-1");
	});

	it("returns the account's enabled regions when rows exist (overriding the fallback)", async () => {
		state.rows = [{ code: "eu-west-1" }, { code: "eu-central-1" }];
		const regions = await getRegionCapabilities("ci-1", "aws");
		expect(regions).toEqual(["eu-west-1", "eu-central-1"]);
	});
});

describe("getInstanceTypeCapabilities", () => {
	it("fails open to the static catalog (no per-account launch verdict) when nothing has synced", async () => {
		state.rows = [];
		const types = await getInstanceTypeCapabilities("ci-1", "aws");
		expect(types).toHaveLength(INSTANCE_TYPES.aws.length);
		expect(types[0]).toMatchObject({
			value: INSTANCE_TYPES.aws[0].value,
			cost: INSTANCE_TYPES.aws[0].cost,
		});
		// Static fallback carries no account-accurate verdict.
		expect(types[0].launchable).toBeUndefined();
	});

	it("surfaces the tri-state launchable guidance from synced rows", async () => {
		state.rows = [
			{
				value: "m5.large",
				name: "m5.large",
				vcpu: 2,
				memGb: 8,
				launchable: "not_launchable",
				launchableReason: "quota_zero",
			},
			{
				value: "t3.medium",
				name: "t3.medium",
				vcpu: 2,
				memGb: 4,
				launchable: "not_evaluable",
				launchableReason: "quota_unknown",
			},
		];
		const types = await getInstanceTypeCapabilities("ci-1", "aws", "us-east-1");
		expect(types).toHaveLength(2);
		expect(types[0]).toMatchObject({
			value: "m5.large",
			vcpu: 2,
			memoryGb: 8,
			launchable: "not_launchable",
			launchableReason: "quota_zero",
		});
		// A federated row carries no static "cost" estimate.
		expect(types[0].cost).toBeUndefined();
		expect(types[1].launchable).toBe("not_evaluable");
	});
});
