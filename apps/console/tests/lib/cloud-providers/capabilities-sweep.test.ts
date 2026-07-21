// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The capability refresh sweep (#938). The due-connections predicate must exclude `pending` placeholders
// and treat a NULL `capabilities_synced_at` as due (so the Tier-2 event-NULL nudge is honored), and the
// per-row claim must only proceed when its conditional UPDATE actually flipped a row.

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	// Rows the conditional-claim UPDATE returns (empty = a racing replica already claimed it).
	claimReturns: [] as unknown[],
	wherePredicate: undefined as unknown,
}));

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/cloud-providers/capabilities/index", () => ({
	gcRemovedCapabilities: vi.fn().mockResolvedValue(0),
	hasServerSideCapabilities: vi.fn(() => false),
	syncCloudCapabilities: vi.fn(),
}));

import {
	claimDueCapability,
	runCapabilitySweep,
} from "@/lib/cloud-providers/capabilities/sweep";
import { getServiceDb } from "@/lib/db";

beforeEach(() => {
	h.claimReturns = [];
	h.wherePredicate = undefined;
	vi.clearAllMocks();
});

describe("runCapabilitySweep — due filter", () => {
	it("excludes pending and treats a null sync stamp as due", async () => {
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			select: () => chain,
			from: () => chain,
			where: (pred: unknown) => {
				h.wherePredicate = pred;
				return chain;
			},
			limit: () => Promise.resolve([]), // no due rows → loop is a no-op
		});
		vi.mocked(getServiceDb).mockReturnValue(chain as never);

		const result = await runCapabilitySweep();
		expect(result).toEqual({ checked: 0, synced: 0 });

		const { sql, params } = new PgDialect().sqlToQuery(h.wherePredicate as never);
		expect(params).toContain("pending"); // pending placeholders excluded
		expect(sql).toMatch(/is null/i); // NULL stamp counts as due (Tier-2 nudge)
	});
});

describe("claimDueCapability", () => {
	function updateChain() {
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			set: () => chain,
			where: () => chain,
			returning: () => Promise.resolve(h.claimReturns),
		});
		return { update: () => chain };
	}

	it("returns false when the conditional update flips no row (already claimed)", async () => {
		h.claimReturns = [];
		vi.mocked(getServiceDb).mockReturnValue(updateChain() as never);
		expect(await claimDueCapability("ci-1")).toBe(false);
	});

	it("returns true when this replica flipped the row", async () => {
		h.claimReturns = [{ id: "ci-1" }];
		vi.mocked(getServiceDb).mockReturnValue(updateChain() as never);
		expect(await claimDueCapability("ci-1")).toBe(true);
	});
});
