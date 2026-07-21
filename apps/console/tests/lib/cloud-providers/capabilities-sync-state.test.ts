// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The Tier-1 change-detection gate (#938). Covers the hash determinism, the due/not-due matrix (no row ⇒
// due, matching hash within TTL ⇒ not due, changed hash ⇒ due, matching hash past TTL ⇒ due), the two-axis
// record, and the skipped-region native-id backfill that keeps softRemoveUnseen from wrongly removing a
// type offered only in a skipped region.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	// The row returned by the mocked SELECT (axisDue / existingNativeIds). Set per test.
	rows: [] as unknown[],
	inserted: [] as unknown[],
	throwOnRead: false,
}));

vi.mock("@/lib/db", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => chain,
		insert: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => chain,
		values: (v: unknown) => {
			h.inserted.push(v);
			return chain;
		},
		onConflictDoUpdate: () => chain,
		// Awaiting any built query yields the configured rows (or simulates a transient DB error).
		then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
			h.throwOnRead ? rej(new Error("db down")) : res(h.rows),
	});
	return { getServiceDb: () => chain };
});

import {
	existingNativeIds,
	hashSource,
	INSTANCE_TYPES_TTL_MS,
	recordRegionHashes,
	regionDue,
} from "@/lib/cloud-providers/capabilities/sync-state";

beforeEach(() => {
	h.rows = [];
	h.inserted = [];
	h.throwOnRead = false;
	vi.clearAllMocks();
});

describe("hashSource", () => {
	it("is order-independent for Sets and Maps", () => {
		expect(hashSource(new Set(["b", "a", "c"]))).toBe(
			hashSource(new Set(["c", "a", "b"])),
		);
		expect(
			hashSource(
				new Map([
					["x", 1],
					["y", 2],
				]),
			),
		).toBe(
			hashSource(
				new Map([
					["y", 2],
					["x", 1],
				]),
			),
		);
	});

	it("is independent of object key order but sensitive to content", () => {
		expect(hashSource({ a: 1, b: 2 })).toBe(hashSource({ b: 2, a: 1 }));
		expect(hashSource(new Set(["a", "b"]))).not.toBe(
			hashSource(new Set(["a", "b", "c"])),
		);
		// A quota flip changes the hash.
		expect(hashSource(new Map([["standard", 0]]))).not.toBe(
			hashSource(new Map([["standard", 64]])),
		);
	});
});

describe("regionDue", () => {
	const base = {
		cloudIdentityId: "ci-1",
		provider: "aws" as const,
		region: "us-east-1",
		instanceHash: "hash-A",
	};

	it("is due when there is no prior row", async () => {
		h.rows = [];
		expect(await regionDue(base)).toBe(true);
	});

	it("is NOT due when the hash matches within the TTL", async () => {
		h.rows = [{ source_hash: "hash-A", hashed_at: new Date() }];
		expect(await regionDue(base)).toBe(false);
	});

	it("is due when the stored hash differs", async () => {
		h.rows = [{ source_hash: "hash-OLD", hashed_at: new Date() }];
		expect(await regionDue(base)).toBe(true);
	});

	it("is due when the hash matches but the TTL has lapsed", async () => {
		const stale = new Date(Date.now() - INSTANCE_TYPES_TTL_MS - 60_000);
		h.rows = [{ source_hash: "hash-A", hashed_at: stale }];
		expect(await regionDue(base)).toBe(true);
	});

	it("fails open (due) when the DB read throws", async () => {
		h.throwOnRead = true;
		expect(await regionDue(base)).toBe(true);
	});
});

describe("recordRegionHashes", () => {
	it("records both axes when a quota hash is present", async () => {
		await recordRegionHashes({
			cloudIdentityId: "ci-1",
			provider: "aws",
			region: "us-east-1",
			instanceHash: "i-hash",
			quotaHash: "q-hash",
		});
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ axis: "instance_types", source_hash: "i-hash" }),
		);
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ axis: "quota", source_hash: "q-hash" }),
		);
	});

	it("records only instance_types when there is no quota axis (Hetzner)", async () => {
		await recordRegionHashes({
			cloudIdentityId: "ci-1",
			provider: "hetzner",
			region: "fsn1",
			instanceHash: "i-hash",
		});
		expect(h.inserted).toHaveLength(1);
		expect(h.inserted[0]).toEqual(
			expect.objectContaining({ axis: "instance_types" }),
		);
	});
});

describe("existingNativeIds", () => {
	it("returns the stored non-removed native ids for a region", async () => {
		h.rows = [{ native_id: "m5.large" }, { native_id: "c5.large" }];
		expect(await existingNativeIds("ci-1", "us-east-1")).toEqual([
			"m5.large",
			"c5.large",
		]);
	});
});
