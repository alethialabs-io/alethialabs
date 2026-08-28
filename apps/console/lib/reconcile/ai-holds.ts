// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Release stranded AI budget holds, on the supervised reconcile loop (#2683).
//
// A metered turn reserves a provisional `METERED_RESERVE_CREDITS` row up front (assertAiAllowed)
// which `recordAiUsage` reconciles IN PLACE when the turn ends — settled, errored or empty. The
// contract written on assertAiAllowed is absolute:
//
//   that row is reconciled/released IN PLACE … so a settled, errored, or empty turn NEVER leaks
//   its ≈$0.10 hold.
//
// The reconciling write is fire-and-forget, so it can fail. `meteringFailed` makes that visible —
// it logs "a budget hold may be stranded" — and until now nothing acted on it. A log line does not
// meet "never": the reservation keeps counting against the org's weekly headroom until the window
// rolls, with no ledger row explaining where the headroom went. The org is billed-in-effect for a
// turn that was never recorded.
//
// The process dying between the reserve and the reconcile has the same effect and cannot be caught
// in-process at all, which is why this is a sweep rather than a retry.

import { and, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { aiUsageLedger } from "@/lib/db/schema";

/**
 * How old an outstanding hold must be before it is certainly stranded.
 *
 * DERIVED, not picked. A metered turn is bounded above by two things: every AI entry point in the
 * console stops at `stepCountIs(8)`, and the request itself dies at the platform's function
 * timeout. Neither admits an hour. So a hold that has been outstanding for one is not a turn still
 * running — it is a turn whose reconciling write never landed.
 *
 * Erring long is the safe direction. Sweeping too early would release a hold out from under a live
 * turn, which then reconciles it a second time and books the cost twice; sweeping late merely
 * leaves ≈$0.10 reserved for a while longer, which is the condition being fixed.
 */
export const STRANDED_HOLD_AGE_MINUTES = 60;

/**
 * Max rows released per pass. Mirrors GC_BATCH_LIMIT in gc.ts: bounded so a backlog drains over
 * passes instead of taking a long lock on the ledger.
 */
const RELEASE_BATCH_LIMIT = 1000;

/**
 * Release every hold older than {@link STRANDED_HOLD_AGE_MINUTES} to 0 credits.
 *
 * `settled_at IS NULL` is an EXACT predicate for "outstanding hold", not a heuristic, and it is
 * exact only because both writing paths in ai-quota.ts stamp it — the reconcile UPDATE and the
 * plain INSERT. A future write path that forgets to stamp would make its rows look strandable, and
 * they would be released to zero. That is money, so it is stated here as well as at the column.
 *
 * Released to 0 rather than deleted: the row is the evidence that a turn happened and its hold was
 * never reconciled. Deleting it would make the sweep itself unauditable — the opposite of the
 * problem being solved.
 */
export async function releaseStrandedAiHolds(db: Db): Promise<{ released: number }> {
	const cutoff = sql`now() - make_interval(mins => ${STRANDED_HOLD_AGE_MINUTES})`;
	const doomed = db
		.select({ id: aiUsageLedger.id })
		.from(aiUsageLedger)
		.where(and(isNull(aiUsageLedger.settled_at), lt(aiUsageLedger.created_at, cutoff)))
		.limit(RELEASE_BATCH_LIMIT);

	const rows = await db
		.update(aiUsageLedger)
		.set({ credits: 0, settled_at: sql`now()` })
		.where(sql`${aiUsageLedger.id} in (${doomed})`)
		.returning({ id: aiUsageLedger.id });

	return { released: rows.length };
}
