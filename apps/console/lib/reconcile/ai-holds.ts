// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Release stranded AI budget holds, on the supervised reconcile loop (#2683): the `release-ai-holds`
// task, every 15 minutes (`loop.ts`). It is the ONE sweep that owns stranded holds (ADR 0003 §8.2,
// Q5, `docs/adr/0003-chat-turn-answered-and-billed-once.md`); there is no second.
//
// A metered turn reserves a provisional `METERED_RESERVE_CREDITS` row up front, which `recordAiUsage`
// reconciles IN PLACE when the turn ends and stamps `settled_at`. A reconciling write that fails
// (`meteringFailed` logs it) or a process that dies between the reserve and the reconcile leaves the
// row outstanding, counting against the org's weekly headroom with no ledger row explaining where it
// went. That cannot be caught in-process, which is why this is a sweep rather than a retry.
//
// One run is three passes, in this order (§8.2):
//   1. C8: `running` turn claims whose lease is silent or that are past their age bound are set
//      `expired` and their holds released to 0 (`expireSilentTurns`, one transaction per claim, each
//      candidate re-checked under its locks). One run takes at most 500 and skips a claim whose
//      thread is locked (SKIP LOCKED); the next run picks up the rest;
//   2. every outstanding hold older than {@link STRANDED_HOLD_AGE_MINUTES} that NO `running` claim
//      names is released to 0. A claimed hold is released only through its claim (pass 1), never by
//      age;
//   3. retention: terminal claims (`state <> 'running'`) whose `finished_at` is older than
//      {@link CLAIM_RETENTION_DAYS} are deleted, whether or not their thread still exists.
//
// No chat route calls `reserveTurn` yet, so until ADR 0003 slice 6 cuts them over no hold is claimed
// in production and passes 1 and 3 find nothing there; every hold is pass 2's.

import { and, isNull, lt, ne, sql } from "drizzle-orm";
import { expireSilentTurns } from "@/lib/agent/turn-claims";
import type { Db } from "@/lib/db";
import { agentTurnClaims, aiUsageLedger } from "@/lib/db/schema";

/**
 * How old an unclaimed outstanding hold must be before pass 2 releases it.
 *
 * ASSUMED, not derived (ADR 0003 §8.2). The console runs as a standalone Node server, so the
 * `maxDuration` exports bound nothing, and no platform timeout ends a request. What bounds a hold:
 * - a hold a `running` turn claim names is never read by this pass (it is excluded below); its turn
 *   is bounded by `TURN_BUDGET_MS` (15 minutes) and its release by C8 in pass 1. From ADR 0003
 *   slice 6 the chat routes' holds will be claimed; today no route claims one;
 * - every other hold (today every chat route's, the support and agent-identity routes', the
 *   `colony` and `verify` actions', and a turn that ran on the old process across a deploy) has NO
 *   time bound at all. For those, 60 minutes is an assumption.
 *
 * 60 minutes is longer than `TURN_BUDGET_MS` + the 90 s lease + one sweep interval (about 32
 * minutes), so this pass could not release a live claimed hold even without its exclusion. For an
 * unbounded caller that runs past it, an early release costs headroom accuracy only, not money: the
 * late settle overwrites the row in place (`recordAiUsage`) and the turn is billed once.
 */
export const STRANDED_HOLD_AGE_MINUTES = 60;

/** How long a terminal turn claim is kept after `finished_at` (ADR 0003 Q10), deleted thread or not. */
export const CLAIM_RETENTION_DAYS = 30;

/**
 * Max rows one pass releases or deletes. Mirrors GC_BATCH_LIMIT in gc.ts: bounded so a backlog
 * drains over runs instead of taking a long lock on the table.
 */
const SWEEP_BATCH_LIMIT = 1000;

/**
 * What one run of the sweep did, pass by pass. A type alias, not an interface, so it satisfies the
 * `Record<string, number>` that `runTask` records on the heartbeat.
 */
export type HoldSweepResult = {
	/** Pass 1: running claims set `expired`, each with its hold released to 0. */
	expired: number;
	/** Pass 2: unclaimed outstanding holds released to 0. */
	released: number;
	/** Pass 3: terminal claims deleted past their retention. */
	removed: number;
};

/**
 * The `release-ai-holds` task: the three passes of ADR 0003 §8.2, in order (see the file header).
 *
 * Pass 1 runs on the service-role pool (`expireSilentTurns` opens its own transactions); passes 2
 * and 3 run on `db`, which the reconcile loop passes as that same service-role pool. A pass that
 * throws aborts the run, and `runTask` records it; the next run starts again from pass 1.
 */
export async function releaseStrandedAiHolds(db: Db): Promise<HoldSweepResult> {
	const { expired } = await expireSilentTurns();
	const released = await releaseUnclaimedHolds(db);
	const removed = await removeFinishedClaims(db);
	return { expired, released, removed };
}

/**
 * Pass 2: release to 0 every hold that is outstanding, older than {@link STRANDED_HOLD_AGE_MINUTES},
 * and named by no `running` claim.
 *
 * `settled_at IS NULL` is an EXACT predicate for "outstanding hold", not a heuristic, and it is
 * exact only because both writing paths in ai-quota.ts stamp it: the reconcile UPDATE and the plain
 * INSERT. A future write path that forgets to stamp would make its rows look strandable, and they
 * would be released to zero. That is money, so it is stated here as well as at the column.
 *
 * The candidates are locked `FOR UPDATE SKIP LOCKED` (a hold a settle or a C8 transaction holds is
 * left for the next run), and the UPDATE repeats every predicate on the row it writes, so a hold
 * that settled after this statement took its snapshot is re-checked against its committed version
 * and NOT zeroed. The `running`-claim exclusion is read without a lock: a claim only ever names the hold its
 * own acceptance reserved in the same transaction, so no claim can start naming a hold this old.
 *
 * Released to 0 rather than deleted: the row is the evidence that a turn happened and its hold was
 * never reconciled. Deleting it would make the sweep itself unauditable.
 */
async function releaseUnclaimedHolds(db: Db): Promise<number> {
	const stranded = and(
		isNull(aiUsageLedger.settled_at),
		lt(aiUsageLedger.created_at, sql`now() - make_interval(mins => ${STRANDED_HOLD_AGE_MINUTES})`),
		sql`not exists (select 1 from ${agentTurnClaims} where ${agentTurnClaims.hold_id} = ${aiUsageLedger.id} and ${agentTurnClaims.state} = 'running')`,
	);
	const doomed = db
		.select({ id: aiUsageLedger.id })
		.from(aiUsageLedger)
		.where(stranded)
		.limit(SWEEP_BATCH_LIMIT)
		.for("update", { skipLocked: true });

	const rows = await db
		.update(aiUsageLedger)
		.set({ credits: 0, settled_at: sql`now()` })
		.where(and(sql`${aiUsageLedger.id} in (${doomed})`, stranded))
		.returning({ id: aiUsageLedger.id });
	return rows.length;
}

/**
 * Pass 3 (retention, ADR 0003 Q10): delete every terminal claim whose `finished_at` is older than
 * {@link CLAIM_RETENTION_DAYS}. A `running` claim is never deleted (it has no `finished_at`, and the
 * state is matched as well). Claims have no foreign key to their thread, so a deleted thread's
 * claims are kept the same 30 days and removed here. Like pass 2, the candidates are locked
 * `SKIP LOCKED` and the DELETE repeats the predicate, so a claim re-armed to `running` meanwhile
 * is not deleted.
 */
async function removeFinishedClaims(db: Db): Promise<number> {
	const finished = and(
		ne(agentTurnClaims.state, "running"),
		lt(agentTurnClaims.finished_at, sql`now() - make_interval(days => ${CLAIM_RETENTION_DAYS})`),
	);
	const doomed = db
		.select({ id: agentTurnClaims.id })
		.from(agentTurnClaims)
		.where(finished)
		.limit(SWEEP_BATCH_LIMIT)
		.for("update", { skipLocked: true });

	const rows = await db
		.delete(agentTurnClaims)
		.where(and(sql`${agentTurnClaims.id} in (${doomed})`, finished))
		.returning({ id: agentTurnClaims.id });
	return rows.length;
}
