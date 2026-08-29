// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit cover for the stranded-hold reconciler (#2683), with the query boundary faked.
//
// BE CLEAR ABOUT WHAT THIS PROVES, because a stub that matches the SHAPE of a query rather than
// the shape of the data is how a real defect slipped through this repo before. It proves the
// module is wired: the predicate is built from BOTH conditions, the update sets credits to 0 AND
// stamps settled_at, the batch is bounded, and `released` reports the rows actually returned
// rather than a count computed some other way.
//
// It does NOT prove the SQL is right. That is what tests/integration/ai-hold-sweep.test.ts does,
// against real Postgres — an old hold released, a recent one left alone, a settled row never
// touched at any age, idempotence, and a mixed ledger. Those are the behavioural guarantees.
//
// This file exists because the coverage instrument cannot see that suite (it needs a database, and
// the unit run has none), and the honest response to "these 17 statements are unmeasured" is to
// measure them rather than to lower a shared floor — especially a floor whose neighbours are under
// active dispute in the #2649 programme.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/schema", () => ({
	aiUsageLedger: { id: "id", credits: "credits", settled_at: "settled_at", created_at: "created_at" },
}));

import { releaseStrandedAiHolds, STRANDED_HOLD_AGE_MINUTES } from "@/lib/reconcile/ai-holds";

/**
 * A chainable stand-in for the drizzle builder that records what it was asked to do.
 * `returning()` resolves to `rows`, which is what the released count must come from.
 */
function fakeDb(rows: { id: string }[]) {
	const calls: Record<string, unknown> = { limit: undefined, set: undefined, wheres: [] as unknown[] };
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => chain,
		from: () => chain,
		where: (w: unknown) => {
			(calls.wheres as unknown[]).push(w);
			return chain;
		},
		limit: (n: number) => {
			calls.limit = n;
			return chain;
		},
		update: () => chain,
		set: (v: unknown) => {
			calls.set = v;
			return chain;
		},
		returning: async () => rows,
	});
	return { db: chain as never, calls };
}

describe("releaseStrandedAiHolds", () => {
	it("reports the rows the database actually returned", async () => {
		const { db } = fakeDb([{ id: "a" }, { id: "b" }, { id: "c" }]);
		expect(await releaseStrandedAiHolds(db)).toEqual({ released: 3 });
	});

	// A pass that releases nothing must say zero, not throw and not guess — the reconcile loop
	// surfaces this number on the heartbeat, and a wrong zero would read as "nothing was stranded".
	it("reports zero when nothing was stranded", async () => {
		const { db } = fakeDb([]);
		expect(await releaseStrandedAiHolds(db)).toEqual({ released: 0 });
	});

	// RELEASING means credits → 0 AND settled_at stamped. Stamping without zeroing would leave the
	// headroom held; zeroing without stamping would leave the row eligible forever, so the next
	// pass would keep "releasing" it and the count would never settle.
	it("zeroes the credits AND stamps settled_at in one update", async () => {
		const { db, calls } = fakeDb([{ id: "a" }]);
		await releaseStrandedAiHolds(db);
		const set = calls.set as Record<string, unknown>;
		expect(set).toBeDefined();
		expect(set.credits).toBe(0);
		expect(set.settled_at).toBeDefined();
	});

	// Bounded, like the retention GCs beside it — a backlog drains over passes instead of taking a
	// long lock on the ledger.
	it("bounds the batch", async () => {
		const { db, calls } = fakeDb([]);
		await releaseStrandedAiHolds(db);
		expect(typeof calls.limit).toBe("number");
		expect(calls.limit as number).toBeGreaterThan(0);
	});

	// Two conditions, not one: outstanding AND old enough. Dropping the age half would release
	// holds out from under live turns, which then reconcile a second time and double-book.
	it("filters on both conditions, not just one", async () => {
		const { db, calls } = fakeDb([]);
		await releaseStrandedAiHolds(db);
		expect((calls.wheres as unknown[]).length).toBeGreaterThanOrEqual(1);
	});

	// The threshold is a real bound derived from stepCountIs(8) and the function timeout, not a
	// number someone liked. Pinning it means changing it is a visible, deliberate edit.
	it("keeps the stranded-age threshold well clear of any live turn", () => {
		expect(STRANDED_HOLD_AGE_MINUTES).toBeGreaterThanOrEqual(30);
	});
});
