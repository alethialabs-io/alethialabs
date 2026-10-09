// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Retention health: is each promise actually being kept, on THIS instance, right now (#2373).
//
// The register says what the window is and what enforces it. This answers the question a register
// cannot: whether the enforcement is working. A `gc_*` function that has been erroring for a month
// leaves the register looking correct and the data still there — which is precisely the failure a
// "policy-only retention promise" produces, just with more machinery in front of it.
//
// So health is measured from the DATA, not from the scheduler: the oldest surviving row each entry
// governs, compared against that entry's effective window. A GC that is running answers
// "oldest row is inside the window" no matter how it is scheduled; a GC that has silently stopped
// answers with a growing overrun, and says by how much.

import { type SQL, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { EFFECTIVE_RETENTION_DAYS } from "@/lib/reconcile/gc";
import {
	type RetentionEntry,
	RETENTION_REGISTRY,
	enforcedRetention,
} from "./registry";

/** One entry's live state. */
export interface RetentionHealthRow {
	readonly id: string;
	readonly subject: string;
	readonly mechanism: RetentionEntry["mechanism"];
	/** The window this instance is running, after env overrides. Null when not self-enforced. */
	readonly effectiveWindowDays: number | null;
	/** The window the register publishes. Differs from the above only under an env override. */
	readonly publishedWindowDays: number | null;
	/** Age in days of the oldest surviving row. Null when not measurable (no table, or empty). */
	readonly oldestRowAgeDays: number | null;
	/** True when the oldest row is older than the window — the GC is behind, or not running. */
	readonly overdue: boolean;
	/** How far past the window the oldest row is, in days. 0 when not overdue. */
	readonly overdueByDays: number;
	/** The open gap for a promise nothing enforces; null when it is enforced. */
	readonly gap: string | null;
}

/**
 * A slack the overrun check allows before calling a table overdue.
 *
 * The GC deletes in bounded batches on a 15-minute schedule, so the oldest row is legitimately a
 * little past the window between passes, and a big backlog drains over several passes rather than
 * at once. Without slack, a healthy instance reports overdue constantly and the signal stops being
 * read — which is worse than not having it. One day is comfortably more than a drain takes and
 * still far tighter than the shortest window.
 */
const OVERRUN_SLACK_DAYS = 1;

/**
 * The slack for a `reconcile-task` entry: the GC's one day plus the task's cadence.
 *
 * The only `reconcile-task` today, `elench-drafts-sweep`, runs once a day (its interval in
 * lib/reconcile/loop.ts), so a row may legitimately sit up to a day past its window before the next
 * pass deletes it — the register itself says a discarded draft "can stay up to about two days". With
 * the GC's one-day slack alone, the limit for the 1-day discarded-drafts window would be two days,
 * exactly that legitimate maximum, so any ordinary delay (a restart, a backlog draining over several
 * passes) would read as overdue. Nothing derives this from the loop's interval: a task given a
 * longer cadence needs this raised with it.
 */
const RECONCILE_TASK_SLACK_DAYS = OVERRUN_SLACK_DAYS + 1;

/**
 * Runs one fixed age query and returns its `age_days`, or null when no row matched. The seam the
 * measurement runs through: `retentionHealth` answers it from the database, and a unit test answers
 * it directly.
 */
export type AgeQuery = (query: SQL) => Promise<number | null>;

/** Age in days of the oldest row in `table`, or null when the table is empty. */
async function oldestRowAgeDays(age: AgeQuery, table: string): Promise<number | null> {
	// The column differs per table only in name; every governed table stamps its insert time. Chosen
	// from a fixed map rather than interpolated from caller input — this is raw SQL identifier
	// interpolation, and a table name that reached it from anywhere but the register would be an
	// injection point.
	const column = TIMESTAMP_COLUMN[table];
	if (!column) return null;
	return age(
		sql`select extract(epoch from (now() - min(${sql.identifier(column)}))) / 86400 as age_days
		    from ${sql.identifier(table)}`,
	);
}

/** Runs one fixed age query and reads its single `age_days` value; null when no row matched. */
async function ageOfOldest(db: Db, query: SQL): Promise<number | null> {
	const rows = await db.execute<{ age_days: number | null }>(query);
	const raw = rows[0]?.age_days;
	return raw === null || raw === undefined ? null : Number(raw);
}

/**
 * The insert-time column per governed table.
 *
 * An allow-list, and the ONLY source of table and column names that reach the SQL above. Both are
 * interpolated as identifiers, so accepting either from anywhere else — a request, a config, a
 * registry entry that someone edited — would be an injection point. A table missing from here
 * reports "not measurable" rather than being queried on a guessed column.
 */
const TIMESTAMP_COLUMN: Readonly<Record<string, string>> = {
	job_logs: "created_at",
	fleet_actions: "created_at",
	authz_activity_log: "ts",
};

/**
 * The age query per `reconcile-task` entry, keyed by entry id rather than by table.
 *
 * Two entries share `elench_drafts`, and neither window runs from the insert time: a discarded draft
 * is aged from `discarded_at`, and an active one from `updated_at` (lib/elench/drafts-sweep.ts deletes
 * on exactly these predicates). Taking `min(created_at)` over the whole table would report a draft
 * written yesterday but created two months ago as overdue, and a discarded one as inside its window.
 * A `sending` row is in neither query: the sweep never deletes one, so its age is not a breach.
 *
 * Fixed SQL, for the same reason as `TIMESTAMP_COLUMN`: nothing from outside this file reaches it.
 */
const RECONCILE_TASK_AGE: Readonly<Record<string, SQL>> = {
	"elench-drafts": sql`select extract(epoch from (now() - min(updated_at))) / 86400 as age_days
	    from elench_drafts where status = 'active'`,
	"elench-drafts-discarded": sql`select extract(epoch from (now() - min(discarded_at))) / 86400 as age_days
	    from elench_drafts where status = 'discarded'`,
};

/** Whether this entry is enforced by code this product runs, as opposed to a documented gap. */
function selfEnforced(entry: RetentionEntry): boolean {
	return entry.mechanism === "gc-function" || entry.mechanism === "reconcile-task";
}

/** Age in days of the oldest row `entry`'s enforcement would delete, or null when not measurable. */
async function measureEntry(age: AgeQuery, entry: RetentionEntry): Promise<number | null> {
	if (entry.mechanism === "gc-function") {
		return entry.table ? oldestRowAgeDays(age, entry.table) : null;
	}
	if (entry.mechanism === "reconcile-task") {
		const query = RECONCILE_TASK_AGE[entry.id];
		return query ? age(query) : null;
	}
	return null;
}

/**
 * The live retention picture for this instance.
 *
 * Best-effort per row: a table that cannot be measured reports `oldestRowAgeDays: null` rather than
 * failing the whole report. A health report that refuses to render because one table is missing
 * tells an operator less than a partial one that names the hole.
 */
export async function retentionHealth(db: Db): Promise<RetentionHealthRow[]> {
	return measureRetention((query) => ageOfOldest(db, query));
}

/** The live retention picture, measured through `age` — `retentionHealth` without the database. */
export async function measureRetention(age: AgeQuery): Promise<RetentionHealthRow[]> {
	const out: RetentionHealthRow[] = [];
	for (const entry of RETENTION_REGISTRY) {
		// A `reconcile-task` reads its window from the register itself (no env override), so the
		// published window is the effective one.
		const effective =
			entry.mechanism === "gc-function"
				? (EFFECTIVE_RETENTION_DAYS[entry.id] ?? entry.windowDays)
				: entry.mechanism === "reconcile-task"
					? entry.windowDays
					: null;

		let oldest: number | null = null;
		try {
			oldest = await measureEntry(age, entry);
		} catch {
			// Unreadable table (permissions, a rename mid-migration): report it as unmeasured
			// rather than throwing away every other row's answer.
			oldest = null;
		}

		const slack =
			entry.mechanism === "reconcile-task" ? RECONCILE_TASK_SLACK_DAYS : OVERRUN_SLACK_DAYS;
		const limit = effective === null ? null : effective + slack;
		const overdue = oldest !== null && limit !== null && oldest > limit;
		out.push({
			id: entry.id,
			subject: entry.subject,
			mechanism: entry.mechanism,
			effectiveWindowDays: effective,
			publishedWindowDays: entry.windowDays,
			oldestRowAgeDays: oldest === null ? null : Math.floor(oldest),
			overdue,
			overdueByDays:
				overdue && oldest !== null && effective !== null
					? Math.floor(oldest - effective)
					: 0,
			gap: selfEnforced(entry) ? null : entry.evidence,
		});
	}
	return out;
}

/**
 * Whether any self-enforced retention is behind — the one-line answer for a status surface.
 *
 * Only self-enforced entries (`gc-function`, `reconcile-task`) can be behind. A `provider` or
 * `not-enforced` entry is not "unhealthy"; it is a documented gap, and folding the two together
 * would let a real GC failure hide inside a count that is never zero anyway.
 */
export function retentionBreaches(rows: RetentionHealthRow[]): RetentionHealthRow[] {
	return rows.filter((r) => r.overdue);
}

/** The register's own consistency: every enforced entry names a window. Cheap, and it has to hold. */
export function registryIsWellFormed(): boolean {
	return enforcedRetention().every((e) => e.windowDays !== null && e.gcFunction !== null);
}
