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
//
// ADR 0003 slice 7 (§8.2) makes the same task own turn claims too, and the second block asserts it:
//
//   5. a running claim whose lease is silent, or that is past its age bound although its lease is
//      fresh, is expired and its hold released to 0 (C8, pass 1)
//   6. a LIVE claim (fresh lease, young) and its hold are left alone, also when the lease was
//      renewed after the sweep picked the claim as a candidate: each candidate is re-checked under
//      its lock
//   7. the age pass never releases a hold a running claim names, however old the hold
//   8. retention deletes terminal claims 30 days after `finished_at`, a deleted thread's included,
//      and keeps a younger one

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { agentThreads, agentTurnClaims, aiUsageLedger, type TurnClaimState } from "@/lib/db/schema";
import { TURN_AGE_BOUND_MS, TURN_LEASE_MS } from "@/lib/agent/turn-claims";
import { METERED_RESERVE_CREDITS } from "@/lib/billing/ai-guard";
import {
	CLAIM_RETENTION_DAYS,
	releaseStrandedAiHolds,
	STRANDED_HOLD_AGE_MINUTES,
} from "@/lib/reconcile/ai-holds";
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

// ── ADR 0003 slice 7: the claim passes (§8.2) ────────────────────────────────────────────────────

/** Seconds, as the SQL interval helpers below take them. */
const AGE_BOUND_S = TURN_AGE_BOUND_MS / 1000;
const LEASE_S = TURN_LEASE_MS / 1000;

/** Insert a thread of USER on the service role and return its id. */
async function seedThread(): Promise<string> {
	const [row] = await getServiceDb()
		.insert(agentThreads)
		.values({ user_id: USER, org_id: ORG, title: "sweep", messages: [] })
		.returning({ id: agentThreads.id });
	return row.id;
}

/**
 * Insert one claim of USER on `threadId`, naming `holdId`. Every time is relative to the database's
 * clock: `leaseSecs` from now (negative = silent), `acceptedSecsAgo` and `finishedDaysAgo` back.
 */
async function seedClaim(opts: {
	threadId: string;
	holdId: string | null;
	state: TurnClaimState;
	leaseSecs?: number;
	acceptedSecsAgo?: number;
	finishedDaysAgo?: number;
}): Promise<string> {
	const terminal = opts.state !== "running";
	const [row] = await getServiceDb()
		.insert(agentTurnClaims)
		.values({
			thread_id: opts.threadId,
			user_id: USER,
			turn_id: `u-${randomUUID()}`,
			attempt_key: "answer",
			state: opts.state,
			token: randomUUID(),
			billing_org_id: ORG,
			hold_id: opts.holdId,
			accepted_revision: 2,
			answer_id: opts.state === "answered" ? "a-1" : null,
			lease_until: sql`now() + make_interval(secs => ${opts.leaseSecs ?? LEASE_S})`,
			accepted_at: sql`now() - make_interval(secs => ${opts.acceptedSecsAgo ?? 5})`,
			finished_at: terminal ? sql`now() - make_interval(days => ${opts.finishedDaysAgo ?? 0})` : null,
		})
		.returning({ id: agentTurnClaims.id });
	return row.id;
}

/** One claim by id, or undefined once deleted. */
async function claim(id: string) {
	const [row] = await getServiceDb().select().from(agentTurnClaims).where(eq(agentTurnClaims.id, id));
	return row;
}

/** Remove every claim and thread of USER. */
async function clearClaims() {
	await getServiceDb().delete(agentTurnClaims).where(eq(agentTurnClaims.user_id, USER));
	await getServiceDb().delete(agentThreads).where(eq(agentThreads.user_id, USER));
}

/** Resolve once a backend is waiting on a row lock of agent_turn_claims (the sweep, blocked). */
async function sweepBlockedOnClaim(): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const [row] = await getServiceDb().execute<{ n: number }>(
			sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%agent_turn_claims%' and query ilike '%for update%'`,
		);
		if (row.n > 0) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("the sweep never blocked on the claim's row lock");
}

describeIfDb("release-ai-holds over turn claims (ADR 0003 §8.2, slice 7)", () => {
	beforeEach(async () => {
		await clearClaims();
		await getServiceDb().delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, ORG));
	});

	afterAll(async () => {
		await clearClaims();
		await getServiceDb().delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, ORG));
	});

	it("release-ai-holds expires a silent claim and releases its hold", async () => {
		const threadId = await seedThread();
		const holdId = await seedRow({ ageMinutes: 5, settled: false });
		const id = await seedClaim({ threadId, holdId, state: "running", leaseSecs: -60, acceptedSecsAgo: 300 });

		const result = await releaseStrandedAiHolds(getServiceDb());

		expect(result.expired).toBeGreaterThanOrEqual(1);
		expect(await claim(id)).toMatchObject({ state: "expired", error: "lease-silent" });
		expect((await claim(id)).finished_at).not.toBeNull();
		expect(await read(holdId)).toMatchObject({ credits: 0 });
		expect((await read(holdId)).settled_at).not.toBeNull();
	});

	// A heartbeat timer leaked by a bug keeps the lease fresh for ever; the age bound is what ends it.
	it("release-ai-holds expires a running claim past its age bound although its lease is fresh", async () => {
		const threadId = await seedThread();
		const holdId = await seedRow({ ageMinutes: 20, settled: false });
		const id = await seedClaim({ threadId, holdId, state: "running", acceptedSecsAgo: AGE_BOUND_S + 60 });
		expect((await claim(id)).lease_until.getTime()).toBeGreaterThan(Date.now() - 5_000);

		await releaseStrandedAiHolds(getServiceDb());

		expect(await claim(id)).toMatchObject({ state: "expired", error: "age-bound" });
		expect(await read(holdId)).toMatchObject({ credits: 0 });
	});

	// THE ONE THAT COSTS A USER THEIR ANSWER IF WRONG: a live turn whose hold is released finalizes
	// `lost` and its answer is not stored.
	it("leaves a live claim and its hold alone", async () => {
		const threadId = await seedThread();
		const holdId = await seedRow({ ageMinutes: 1, settled: false });
		const id = await seedClaim({ threadId, holdId, state: "running", acceptedSecsAgo: 60 });

		await releaseStrandedAiHolds(getServiceDb());

		expect(await claim(id)).toMatchObject({ state: "running", error: null, finished_at: null });
		expect(await read(holdId)).toMatchObject({ credits: METERED_RESERVE_CREDITS, settled_at: null });
	});

	// The candidate scan reads a silent lease; the route's heartbeat renews it before the sweep takes
	// the claim's lock. The sweep must decide on the row it LOCKED, not the row it scanned.
	it("re-checks each candidate under its lock: a lease renewed after the scan is not expired", async () => {
		const threadId = await seedThread();
		const holdId = await seedRow({ ageMinutes: 3, settled: false });
		const id = await seedClaim({ threadId, holdId, state: "running", leaseSecs: -10, acceptedSecsAgo: 120 });

		let renew = (): void => {};
		const renewed = new Promise<void>((resolve) => {
			renew = resolve;
		});
		// The heartbeat (C5) takes only the claim's row lock, as `heartbeatTurn` does.
		const heartbeat = getServiceDb().transaction(async (tx) => {
			await tx.select({ id: agentTurnClaims.id }).from(agentTurnClaims).where(eq(agentTurnClaims.id, id)).for("update");
			await renewed;
			await tx
				.update(agentTurnClaims)
				.set({ lease_until: sql`now() + make_interval(secs => ${LEASE_S})` })
				.where(eq(agentTurnClaims.id, id));
		});
		await new Promise((r) => setTimeout(r, 100));

		const sweep = releaseStrandedAiHolds(getServiceDb());
		await sweepBlockedOnClaim();
		renew();
		await heartbeat;
		await sweep;

		expect(await claim(id)).toMatchObject({ state: "running", error: null });
		expect(await read(holdId)).toMatchObject({ credits: METERED_RESERVE_CREDITS, settled_at: null });
	});

	// A claimed hold is released only by its claim's lease or age bound (pass 1), never by the age
	// pass. The claim here is live, so pass 1 leaves it; the hold is older than the age window. Only
	// a RUNNING claim shields its hold: one named by a terminal claim is released by age as before.
	it("release-ai-holds' age pass skips a hold a running claim names", async () => {
		const threadId = await seedThread();
		const claimed = await seedRow({ ageMinutes: OLD, settled: false });
		const live = await seedClaim({ threadId, holdId: claimed, state: "running", acceptedSecsAgo: 60 });
		const unclaimed = await seedRow({ ageMinutes: OLD, settled: false });
		const ofFailed = await seedRow({ ageMinutes: OLD, settled: false });
		await seedClaim({ threadId: await seedThread(), holdId: ofFailed, state: "failed" });

		const { released } = await releaseStrandedAiHolds(getServiceDb());

		expect(released).toBe(2);
		expect(await read(claimed)).toMatchObject({ credits: METERED_RESERVE_CREDITS, settled_at: null });
		expect((await claim(live)).state).toBe("running");
		expect((await read(unclaimed)).credits).toBe(0);
		expect((await read(ofFailed)).credits).toBe(0);
	});

	it("deleteThread leaves the thread's claims, and the retention pass removes them after 30 days", async () => {
		const gone = await seedThread();
		const kept = await seedThread();
		const old = CLAIM_RETENTION_DAYS + 1;
		const goneClaims = [
			await seedClaim({ threadId: gone, holdId: null, state: "answered", finishedDaysAgo: old }),
			await seedClaim({ threadId: gone, holdId: null, state: "failed", finishedDaysAgo: old }),
			await seedClaim({ threadId: gone, holdId: null, state: "expired", finishedDaysAgo: old }),
		];
		// The thread is deleted; its claims stay (no foreign key, ADR 0003 §4.3).
		await getServiceDb().delete(agentThreads).where(eq(agentThreads.id, gone));
		const oldOfLive = await seedClaim({ threadId: kept, holdId: null, state: "answered", finishedDaysAgo: old });
		const young = await seedClaim({
			threadId: kept,
			holdId: null,
			state: "failed",
			finishedDaysAgo: CLAIM_RETENTION_DAYS - 1,
		});
		const running = await seedClaim({ threadId: await seedThread(), holdId: null, state: "running", acceptedSecsAgo: 30 });

		const { removed } = await releaseStrandedAiHolds(getServiceDb());

		expect(removed).toBe(4);
		const left = await getServiceDb()
			.select({ id: agentTurnClaims.id })
			.from(agentTurnClaims)
			.where(inArray(agentTurnClaims.id, [...goneClaims, oldOfLive, young, running]));
		expect(left.map((r) => r.id).sort()).toEqual([young, running].sort());
	});
});
