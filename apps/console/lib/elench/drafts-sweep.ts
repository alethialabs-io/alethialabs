// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench drafts retention sweep (ADR 0001 §9, slice 6). Hosted on the supervised reconcile loop
// (lib/reconcile/loop.ts) as `elench-drafts-sweep`, once a day, so it is heartbeat-supervised and a
// throw never stops its siblings.
//
// Three phases, in this order:
//
//   1. SETTLE. Every `sending` row whose claim has been silent past the 120 s lease is settled
//      exactly as an action settles it (S5, lib/elench/draft-claims.ts `settleIfSilent`): a first
//      turn is released with its words intact, a later turn is consumed or released by what its
//      thread stores. The sweep presents no claim token, so it spares none — but the lease is
//      measured on the database's clock and re-checked under the row lock, so a claim that is
//      still heartbeating is never touched. A settle writes `updated_at`, so the words it hands back
//      start a fresh 30-day window rather than being deleted by phase 3 a moment later.
//   2. DISCARDED. Rows `discarded` more than 24 h ago (`discarded_at`) are deleted.
//   3. STALE. `active` rows not written for 30 days (`updated_at`, Q2) are deleted, whether or not
//      their user is still a member of the org: a suspended member reinstated inside the window
//      gets them back (§8.2).
//
// A `sending` row is NEVER deleted, whatever its age. Only phase 3 reads `updated_at`, and the
// heartbeat renews `claimed_at`, not `updated_at`, so a live claim on an old draft has an old
// `updated_at`; phase 3 names `status = 'active'` for exactly that reason. A silent claim is first
// turned back into an `active` row by phase 1 with a fresh `updated_at`.
//
// Service role, global, no session actor: the sweep acts on every user's and every org's rows by
// design (RLS does not filter it) and touches only rows whose own timestamps have passed. The
// settle runs each row under an actor built from THAT row's own `user_id` and `org_id`, so every
// statement `settleIfSilent` issues — including its `agent_threads` read — stays pinned to the
// row's owner.
//
// Bounded and idempotent under concurrent app instances: every phase works in pages, each page
// locks its rows `FOR UPDATE SKIP LOCKED` and re-checks its predicate, and a run stops after
// `maxPages` pages; a backlog drains over later runs. A second instance skips the rows the first
// holds, and finds the ones it already settled `active` and the ones it deleted gone. The bound is
// PER PROCESS: every app instance hosts its own reconcile loop, so N instances may each run a pass
// a day, and the most a day can touch is N × the bound. The overlap is safe (above); it is not free.
//
// One bad row never stops the purge. A settle that throws is caught for that row alone: its
// transaction rolls back, the error's NAME is logged and counted (`settleFailed`), and the next row
// goes on. The two delete phases always run, whatever the settle did, and each runs even when the
// other threw; a phase failure is re-thrown only after all three ran, as a message naming the phase
// and the error's name.
//
// Drafts may hold pasted secrets, and a driver error's message can quote a statement's parameters
// (drizzle's "Failed query: … params: …"), which for a settle include the row's claim token. So no
// error message from a statement is ever logged or re-thrown here: only `errorName`. Nothing logs a
// row, and the result is counts only.

import { and, asc, eq, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { Actor } from "@/lib/authz/types";
import type { Db } from "@/lib/db";
import { elenchDrafts } from "@/lib/db/schema";
import { settleIfSilent } from "@/lib/elench/draft-claims";
import { errorName } from "@/lib/errors";
import { log } from "@/lib/observability/log";
import { RETENTION_DEFAULT_DAYS } from "@/lib/retention/registry";

const slog = log.child({ component: "elench-drafts-sweep" });

/**
 * How long a discarded draft is kept for an Undo (§6.2) before it is deleted. Read from the
 * retention register (lib/retention/registry.ts), so the published window is the enforced one.
 */
export const DISCARDED_RETENTION_HOURS = RETENTION_DEFAULT_DAYS.elenchDraftsDiscarded * 24;

/** How long a draft nobody writes is kept (Q2), measured from `updated_at`; from the register too. */
export const DRAFT_RETENTION_DAYS = RETENTION_DEFAULT_DAYS.elenchDrafts;

/** The paging bounds of one run. */
export interface DraftsSweepBounds {
	/** Rows per page (each page is one statement, or one transaction per row for the settle). */
	pageSize: number;
	/** Pages per phase per run. */
	maxPages: number;
}

/**
 * The default bounds: up to 10,000 rows a phase per run, per app instance (each instance runs its
 * own loop); a larger backlog drains over later runs.
 */
const DEFAULT_BOUNDS: DraftsSweepBounds = { pageSize: 500, maxPages: 20 };

/** What one sweep pass did. A type alias, not an interface, so it is assignable to the heartbeat's
 *  `Record<string, number>` result shape (lib/reconcile/heartbeat.ts). */
export type DraftsSweepResult = {
	settled: number;
	/** Rows whose settle threw; each was rolled back and skipped, and the run went on. */
	settleFailed: number;
	discardedDeleted: number;
	staleDeleted: number;
};

/**
 * Runs `page` up to `maxPages` times, stopping early once a page handles fewer than `pageSize`
 * rows (the backlog is drained). Returns the total. A page that throws aborts the phase, and the
 * loop host records the failure.
 */
export async function drainPages(
	page: () => Promise<number>,
	bounds: DraftsSweepBounds,
): Promise<number> {
	let total = 0;
	for (let i = 0; i < bounds.maxPages; i++) {
		const n = await page();
		total += n;
		if (n < bounds.pageSize) break;
	}
	return total;
}

/**
 * Discarded past the Undo window, on the database's clock. Typed `SQL`, not `and()`'s
 * `SQL | undefined`: an undefined predicate would make the delete below unconditional.
 */
const discardedExpired: SQL = sql`${eq(elenchDrafts.status, "discarded")} and ${lte(
	elenchDrafts.discarded_at,
	sql`now() - make_interval(hours => ${DISCARDED_RETENTION_HOURS})`,
)}`;

/** Active and not written for the retention window, on the database's clock. Never a `sending` row. */
const activeExpired: SQL = sql`${eq(elenchDrafts.status, "active")} and ${lte(
	elenchDrafts.updated_at,
	sql`now() - make_interval(days => ${DRAFT_RETENTION_DAYS})`,
)}`;

/**
 * Deletes one page of the rows `where` matches, oldest first by `order`, skipping rows another
 * transaction holds. Two statements in one transaction, not `DELETE … WHERE id IN (SELECT … LIMIT
 * n FOR UPDATE SKIP LOCKED)`: with bound parameters Postgres may plan that sub-select as a plain
 * SubPlan, run once per outer row, and each run skips the rows the statement has already deleted and
 * returns the NEXT page. Measured through this driver on Postgres 17, a two-row page deleted all
 * five matching rows. Here the lock is taken first and the delete names only the locked ids, with the
 * predicate repeated, so a page deletes at most `pageSize` rows and never one that stopped matching.
 * Returns the count.
 */
async function deletePage(
	db: Db,
	where: SQL,
	order: typeof elenchDrafts.updated_at | typeof elenchDrafts.discarded_at,
	pageSize: number,
): Promise<number> {
	return db.transaction(async (tx) => {
		const locked = await tx
			.select({ id: elenchDrafts.id })
			.from(elenchDrafts)
			.where(where)
			.orderBy(asc(order))
			.limit(pageSize)
			.for("update", { skipLocked: true });
		if (locked.length === 0) return 0;
		const gone = await tx
			.delete(elenchDrafts)
			.where(
				and(
					inArray(
						elenchDrafts.id,
						locked.map((r) => r.id),
					),
					where,
				),
			)
			.returning({ id: elenchDrafts.id });
		return gone.length;
	});
}

/** What one settle page did: rows settled, and rows whose settle threw. */
interface SettlePageResult {
	settled: number;
	failed: number;
}

/**
 * Settles one page of silent claims (S5). The candidates are the `sending` rows with the oldest
 * `claimed_at`, so every silent claim comes before every live one; each is then locked on its own
 * (skipping one an action holds), and `settleIfSilent` re-reads the lease on the database's clock
 * and leaves a live claim alone. A row whose settle throws is rolled back, logged by error name
 * only, counted, and skipped.
 */
async function settlePage(db: Db, pageSize: number): Promise<SettlePageResult> {
	const candidates = await db
		.select({ id: elenchDrafts.id })
		.from(elenchDrafts)
		.where(eq(elenchDrafts.status, "sending"))
		.orderBy(asc(elenchDrafts.claimed_at))
		.limit(pageSize);
	let settled = 0;
	let failed = 0;
	for (const { id } of candidates) {
		let changed: boolean;
		try {
			changed = await settleOne(db, id);
		} catch (e) {
			failed++;
			slog.error("draft settle failed; row skipped", { error: errorName(e) });
			continue;
		}
		if (changed) settled++;
	}
	return { settled, failed };
}

/** S5 for the one row `id`, in its own transaction; true when it settled the row. */
async function settleOne(db: Db, id: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(elenchDrafts)
			.where(and(eq(elenchDrafts.id, id), eq(elenchDrafts.status, "sending")))
			.limit(1)
			.for("update", { skipLocked: true });
		if (!row) return false;
		const owner: Actor = { userId: row.user_id, orgId: row.org_id };
		const after = await settleIfSilent(tx, owner, row, null);
		return after !== row;
	});
}

/**
 * Runs one phase, and turns a throw into a sanitized record instead of letting it skip the phases
 * after it: the phase's name and the error's name, never its message.
 */
async function runPhase(
	phase: string,
	failures: string[],
	body: () => Promise<number>,
): Promise<number> {
	try {
		return await body();
	} catch (e) {
		const name = errorName(e) ?? "unknown";
		failures.push(`${phase} (${name})`);
		slog.error("drafts sweep phase failed", { phase, error: name });
		return 0;
	}
}

/**
 * The daily `elench-drafts-sweep`: settles silent claims, then deletes discarded drafts past 24 h
 * and active drafts unwritten for 30 days, each phase paged and bounded. Every phase runs even when
 * an earlier one failed; a phase failure is re-thrown at the end, sanitized. Returns counts only.
 */
export async function sweepElenchDrafts(
	db: Db,
	bounds: DraftsSweepBounds = DEFAULT_BOUNDS,
): Promise<DraftsSweepResult> {
	// A settled row leaves the `sending` set, so the next page re-selects from the oldest remaining
	// claim. A page that settles fewer than it read has reached a live claim, and every later claim
	// is younger still, so the drain stops there.
	// A failed row counts as handled for the drain: it stays `sending` and is re-read at the head of
	// the next page, so only `maxPages` bounds how often a run retries it.
	const failures: string[] = [];
	let settled = 0;
	let settleFailed = 0;
	await runPhase("settle", failures, () =>
		drainPages(async () => {
			const page = await settlePage(db, bounds.pageSize);
			settled += page.settled;
			settleFailed += page.failed;
			return page.settled + page.failed;
		}, bounds),
	);
	const discardedDeleted = await runPhase("discarded", failures, () =>
		drainPages(
			() => deletePage(db, discardedExpired, elenchDrafts.discarded_at, bounds.pageSize),
			bounds,
		),
	);
	const staleDeleted = await runPhase("stale", failures, () =>
		drainPages(
			() => deletePage(db, activeExpired, elenchDrafts.updated_at, bounds.pageSize),
			bounds,
		),
	);
	if (failures.length > 0) {
		// The loop host stores this message as the task's lastError: names only, no statement text.
		throw new Error(`elench-drafts-sweep: ${failures.join(", ")} failed`);
	}
	return { settled, settleFailed, discardedDeleted, staleDeleted };
}
