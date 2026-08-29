// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the stranded-AI-hold reconciler, against real Postgres (#2683).
//
// A metered turn reserves a provisional hold that `recordAiUsage` reconciles in place. The
// reconciling write is fire-and-forget, so it can fail — and the process dying between reserve and
// reconcile has the same effect and cannot be caught in-process at all. `meteringFailed` made that
// visible; nothing released it. The reservation kept counting against the org's weekly headroom
// until the window rolled.
//
// What has to be true, and what these assert in both directions:
//
//   1. an OLD outstanding hold is released to 0 and stamped settled
//   2. a RECENT hold is left ALONE — it may still be a live turn, and releasing it would let the
//      turn reconcile a second time and book its cost twice
//   3. a SETTLED row of any age is never touched — this is the one that costs money if wrong,
//      because "released" means "set to 0 credits"
//   4. the sweep is idempotent — a second pass finds nothing
//
// (3) is why `settled_at` exists at all. Before it, the only signature for an outstanding hold was
// "credits still equal the reserve and model IS NULL", which misfires on a real turn that used no
// model and cost the reserve — releasing a genuine charge to zero.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { aiUsageLedger } from "@/lib/db/schema";
import { METERED_RESERVE_CREDITS } from "@/lib/billing/ai-guard";
import { releaseStrandedAiHolds, STRANDED_HOLD_AGE_MINUTES } from "@/lib/reconcile/ai-holds";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();

/** Insert one ledger row `ageMinutes` in the past. `settled` false ⇒ an outstanding hold. */
async function seedRow(opts: {
	ageMinutes: number;
	settled: boolean;
	credits?: number;
}): Promise<string> {
	const [row] = await getServiceDb()
		.insert(aiUsageLedger)
		.values({
			org_id: ORG,
			user_id: USER,
			kind: "agent",
			credits: opts.credits ?? METERED_RESERVE_CREDITS,
			source: "included",
			created_at: sql`now() - make_interval(mins => ${opts.ageMinutes})`,
			settled_at: opts.settled ? sql`now() - make_interval(mins => ${opts.ageMinutes})` : null,
		})
		.returning({ id: aiUsageLedger.id });
	return row.id;
}

async function read(id: string) {
	const [row] = await getServiceDb()
		.select({ credits: aiUsageLedger.credits, settled_at: aiUsageLedger.settled_at })
		.from(aiUsageLedger)
		.where(eq(aiUsageLedger.id, id));
	return row;
}

const OLD = STRANDED_HOLD_AGE_MINUTES + 10;
const RECENT = Math.max(1, STRANDED_HOLD_AGE_MINUTES - 10);

describeIfDb("releaseStrandedAiHolds (#2683)", () => {
	beforeEach(async () => {
		await getServiceDb().delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, ORG));
	});

	afterAll(async () => {
		await getServiceDb().delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, ORG));
	});

	it("releases a hold whose reconciling write never landed", async () => {
		const id = await seedRow({ ageMinutes: OLD, settled: false });
		const { released } = await releaseStrandedAiHolds(getServiceDb());
		expect(released).toBe(1);
		const row = await read(id);
		expect(row.credits).toBe(0);
		// Stamped, or the next pass would find it again forever.
		expect(row.settled_at).not.toBeNull();
	});

	// A hold this young may be a turn still running. Releasing it would let that turn reconcile a
	// SECOND time and book its cost twice — a worse failure than the leak being fixed.
	it("leaves a recent hold alone — it may still be a live turn", async () => {
		const id = await seedRow({ ageMinutes: RECENT, settled: false });
		const { released } = await releaseStrandedAiHolds(getServiceDb());
		expect(released).toBe(0);
		const row = await read(id);
		expect(row.credits).toBe(METERED_RESERVE_CREDITS);
		expect(row.settled_at).toBeNull();
	});

	// THE ONE THAT COSTS MONEY IF WRONG. "Released" means "set to 0 credits", so a settled row swept
	// by mistake is a real charge silently erased.
	it("never touches a settled row, however old", async () => {
		const id = await seedRow({ ageMinutes: OLD * 100, settled: true, credits: 42 });
		const { released } = await releaseStrandedAiHolds(getServiceDb());
		expect(released).toBe(0);
		expect((await read(id)).credits).toBe(42);
	});

	// ...including one that looks exactly like a hold. This is the case the pre-column heuristic
	// ("credits still equal the reserve and no model") would have got wrong.
	it("...including a settled row that costs exactly the reserve and names no model", async () => {
		const id = await seedRow({
			ageMinutes: OLD,
			settled: true,
			credits: METERED_RESERVE_CREDITS,
		});
		const { released } = await releaseStrandedAiHolds(getServiceDb());
		expect(released).toBe(0);
		expect((await read(id)).credits).toBe(METERED_RESERVE_CREDITS);
	});

	it("is idempotent — a second pass finds nothing", async () => {
		await seedRow({ ageMinutes: OLD, settled: false });
		expect((await releaseStrandedAiHolds(getServiceDb())).released).toBe(1);
		expect((await releaseStrandedAiHolds(getServiceDb())).released).toBe(0);
	});

	it("releases only the stranded rows out of a mixed ledger", async () => {
		const stranded = [await seedRow({ ageMinutes: OLD, settled: false }), await seedRow({ ageMinutes: OLD * 2, settled: false })];
		const live = await seedRow({ ageMinutes: RECENT, settled: false });
		const settled = await seedRow({ ageMinutes: OLD, settled: true, credits: 7 });

		expect((await releaseStrandedAiHolds(getServiceDb())).released).toBe(2);

		for (const id of stranded) expect((await read(id)).credits).toBe(0);
		expect((await read(live)).credits).toBe(METERED_RESERVE_CREDITS);
		expect((await read(settled)).credits).toBe(7);
	});
});
