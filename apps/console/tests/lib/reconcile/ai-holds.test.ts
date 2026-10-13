// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit cover for the `release-ai-holds` sweep (#2683, ADR 0003 §8.2), with the query boundary faked.
//
// BE CLEAR ABOUT WHAT THIS PROVES, because a stub that matches the SHAPE of a query rather than
// the shape of the data is how a real defect slipped through this repo before. It proves the
// module is wired: the three passes run in order and each is counted from what it actually did
// (pass 1 from `expireSilentTurns`, passes 2 and 3 from the rows the database returned); pass 2 sets
// credits to 0 AND stamps settled_at; both batches are bounded and their candidates locked
// `SKIP LOCKED`. That each write ALSO repeats its predicate on the row it writes is asserted nowhere:
// the fake cannot read SQL, and no test can open the window it closes, because the subquery's own
// `FOR UPDATE` already re-checks a row that changed after the snapshot. It is defence in depth.
//
// It does NOT prove the SQL is right. That is what tests/integration/ai-hold-sweep.test.ts does,
// against real Postgres: an old hold released, a recent one left alone, a settled row never touched,
// idempotence, a mixed ledger; and for the claims, C8 on a silent or over-age claim, a live claim
// left alone (also when its lease is renewed after the scan), the age pass skipping a claimed hold,
// and 30-day retention. Those are the behavioural guarantees.
//
// This file exists because the coverage instrument cannot see that suite (it needs a database, and
// the unit run has none), and the honest response to "these statements are unmeasured" is to
// measure them rather than to lower a shared floor.

import { beforeEach, describe, expect, it, vi } from "vitest";

const expireSilentTurns = vi.hoisted(() => vi.fn(async () => ({ expired: 0 })));
vi.mock("@/lib/agent/turn-claims", () => ({ expireSilentTurns }));
vi.mock("@/lib/db/schema", () => ({
	aiUsageLedger: { id: "id", credits: "credits", settled_at: "settled_at", created_at: "created_at" },
	agentTurnClaims: { id: "id", hold_id: "hold_id", state: "state", finished_at: "finished_at" },
}));

import type { Db } from "@/lib/db";
import {
	CLAIM_RETENTION_DAYS,
	releaseStrandedAiHolds,
	STRANDED_HOLD_AGE_MINUTES,
} from "@/lib/reconcile/ai-holds";

/** What one write statement (an UPDATE or a DELETE) and the subquery before it were asked to do. */
interface Recorded {
	op: "update" | "delete";
	set: unknown;
	wheres: unknown[];
	limit: number | undefined;
	lock: { strength: unknown; config: unknown } | undefined;
}

/**
 * A chainable stand-in for the drizzle builder that records what it was asked to do. Each write's
 * `returning()` resolves to the next entry of `results`, which is what the counts must come from.
 */
function fakeDb(results: { id: string }[][]): { db: Db; writes: Recorded[]; order: string[] } {
	const writes: Recorded[] = [];
	const order: string[] = [];
	let current: Recorded = { op: "update", set: undefined, wheres: [], limit: undefined, lock: undefined };
	let pending: Pick<Recorded, "limit" | "lock"> & { wheres: unknown[] } = {
		wheres: [],
		limit: undefined,
		lock: undefined,
	};
	const chain = {
		select: () => {
			pending = { wheres: [], limit: undefined, lock: undefined };
			return chain;
		},
		from: () => chain,
		where: (w: unknown) => {
			pending.wheres.push(w);
			return chain;
		},
		limit: (n: number) => {
			pending.limit = n;
			return chain;
		},
		for: (strength: unknown, config: unknown) => {
			pending.lock = { strength, config };
			return chain;
		},
		update: () => {
			current = { op: "update", set: undefined, wheres: [], limit: pending.limit, lock: pending.lock };
			pending = { wheres: current.wheres, limit: undefined, lock: undefined };
			return chain;
		},
		delete: () => {
			current = { op: "delete", set: undefined, wheres: [], limit: pending.limit, lock: pending.lock };
			pending = { wheres: current.wheres, limit: undefined, lock: undefined };
			return chain;
		},
		set: (v: unknown) => {
			current.set = v;
			return chain;
		},
		returning: async () => {
			writes.push(current);
			order.push(current.op);
			return results[writes.length - 1] ?? [];
		},
	};
	// The fake implements only the builder calls the module makes, as the file's earlier fake did.
	return { db: chain as never, writes, order };
}

describe("releaseStrandedAiHolds", () => {
	beforeEach(() => {
		expireSilentTurns.mockReset();
		expireSilentTurns.mockResolvedValue({ expired: 0 });
	});

	it("reports what each pass actually did", async () => {
		expireSilentTurns.mockResolvedValue({ expired: 2 });
		const { db } = fakeDb([[{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "x" }]]);
		expect(await releaseStrandedAiHolds(db)).toEqual({ expired: 2, released: 3, removed: 1 });
	});

	// A pass that does nothing must say zero, not throw and not guess: the reconcile loop surfaces
	// these numbers on the heartbeat, and a wrong zero would read as "nothing was stranded".
	it("reports zeros when nothing was stranded", async () => {
		const { db } = fakeDb([]);
		expect(await releaseStrandedAiHolds(db)).toEqual({ expired: 0, released: 0, removed: 0 });
	});

	// C8 first: a claim it expires has its hold released on its own transaction, so pass 2 then
	// never sees it as outstanding. Then the age pass, then retention.
	it("runs C8, then the age pass, then retention", async () => {
		const seen: string[] = [];
		expireSilentTurns.mockImplementation(async () => {
			seen.push("expire");
			return { expired: 0 };
		});
		const { db, order } = fakeDb([]);
		await releaseStrandedAiHolds(db);
		expect(expireSilentTurns).toHaveBeenCalledTimes(1);
		expect([...seen, ...order]).toEqual(["expire", "update", "delete"]);
	});

	// A pass 1 that throws aborts the run (runTask records it) rather than releasing by age holds
	// whose claims were never examined.
	it("does not run the age pass when C8 throws", async () => {
		expireSilentTurns.mockRejectedValue(new Error("db down"));
		const { db, writes } = fakeDb([]);
		await expect(releaseStrandedAiHolds(db)).rejects.toThrow("db down");
		expect(writes).toHaveLength(0);
	});

	// RELEASING means credits → 0 AND settled_at stamped. Stamping without zeroing would leave the
	// headroom held; zeroing without stamping would leave the row eligible forever.
	it("the age pass zeroes the credits AND stamps settled_at in one update", async () => {
		const { db, writes } = fakeDb([]);
		await releaseStrandedAiHolds(db);
		const [release] = writes;
		expect(release.op).toBe("update");
		expect(release.set).toMatchObject({ credits: 0 });
		expect(release.set).toHaveProperty("settled_at");
	});

	// Bounded, like the retention GCs beside it, and locked SKIP LOCKED so a hold or a claim another
	// transaction holds is left for the next run instead of waited on.
	it("bounds and locks both batches", async () => {
		const { db, writes } = fakeDb([]);
		await releaseStrandedAiHolds(db);
		expect(writes.map((w) => w.op)).toEqual(["update", "delete"]);
		for (const w of writes) {
			expect(w.limit).toBeGreaterThan(0);
			expect(w.lock).toEqual({ strength: "update", config: { skipLocked: true } });
		}
	});

	// 60 minutes is longer than TURN_BUDGET_MS + the lease + one sweep interval (about 32 minutes),
	// so the age pass cannot reach a live claimed hold even without its exclusion (ADR 0003 §8.2).
	// Pinning it means changing it is a visible, deliberate edit.
	it("keeps the age window above a claimed turn's bound, and retention at 30 days", () => {
		expect(STRANDED_HOLD_AGE_MINUTES).toBeGreaterThanOrEqual(33);
		expect(CLAIM_RETENTION_DAYS).toBe(30);
	});
});
