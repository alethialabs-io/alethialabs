// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Retention GC wired into the supervised reconcile loop. Thin wrappers over the bounded-batch GC
// programmables (gc_job_logs / gc_fleet_actions in programmables.sql) — the SQL does the deleting
// (FOR UPDATE SKIP LOCKED, capped at a batch size so it never table-locks); these just call it with
// the configured retention window and surface the deleted count for the heartbeat. Best-effort: the
// loop already isolates a throw per task, so a GC hiccup never blocks the other reconcilers.
//
// One sweep here is TypeScript rather than SQL: `gcSupportCases`, because a support case's
// attachments are files in object storage as well as rows, and only app code can delete the files.

import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { SUPPORT_ATTACHMENTS_BUCKET } from "@/lib/config/storage";
import type { Db } from "@/lib/db";
import { classificationAssignment, supportCaseAttachments, supportCases } from "@/lib/db/schema";
import { RETENTION_DEFAULT_DAYS } from "@/lib/retention/registry";
import { type StorageBackend, storage } from "@/lib/storage";

/**
 * Parse a positive-days retention window from env, falling back to `def` on missing / non-numeric /
 * ≤0. This guards two footguns: a non-numeric value → NaN → make_interval(days => NaN) errors and GC
 * silently never runs; and "0" → a zero-day window that would delete EVERYTHING immediately. Floored
 * at 1 day.
 */
function retentionDays(raw: string | undefined, def: number): number {
	const n = Number(raw);
	return Number.isFinite(n) && n >= 1 ? n : def;
}

// The defaults come from lib/retention/registry.ts, which is what the privacy policy and the
// accountability record publish (#2373). They were three literals here before, so the document could
// say one number while the GC ran another and nothing would notice — a promise nobody enforces is
// the one that ends up in a privacy policy. Now the published window IS the enforced window.

/** Retention window (days) for job_logs before they're GC'd. Override via env. */
const JOB_LOG_RETENTION_DAYS = retentionDays(
	process.env.ALETHIA_JOB_LOG_RETENTION_DAYS,
	RETENTION_DEFAULT_DAYS.jobLogs,
);
/** Retention window (days) for the fleet_actions ledger. Override via env. */
const FLEET_ACTION_RETENTION_DAYS = retentionDays(
	process.env.ALETHIA_FLEET_ACTION_RETENTION_DAYS,
	RETENTION_DEFAULT_DAYS.fleetActions,
);
/**
 * Retention window (days) for the authz_activity_log governance/audit log. Override via env — a full
 * year of enforce() decisions/denials (SOC2-friendly audit retention).
 */
const AUTHZ_ACTIVITY_RETENTION_DAYS = retentionDays(
	process.env.ALETHIA_AUTHZ_ACTIVITY_RETENTION_DAYS,
	RETENTION_DEFAULT_DAYS.authzActivity,
);

/**
 * The window each GC is ACTUALLY running with, after env overrides.
 *
 * Exported for the retention health report: a deployment that overrides a window has changed a
 * published promise, and an operator should be able to see the difference between what the register
 * says and what this instance does — rather than discovering it from a customer.
 */
export const EFFECTIVE_RETENTION_DAYS: Readonly<Record<string, number>> = {
	"job-logs": JOB_LOG_RETENTION_DAYS,
	"fleet-actions": FLEET_ACTION_RETENTION_DAYS,
	"authz-activity": AUTHZ_ACTIVITY_RETENTION_DAYS,
};
/** Max rows deleted per pass — bounds the delete so it can't lock the table. */
const GC_BATCH_LIMIT = 5000;

/** Delete a bounded batch of job_logs past the retention window. Returns rows deleted. */
export async function gcJobLogs(db: Db): Promise<{ deleted: number }> {
	const rows = await db.execute<{ deleted: number }>(
		sql`select public.gc_job_logs(make_interval(days => ${JOB_LOG_RETENTION_DAYS}), ${GC_BATCH_LIMIT}) as deleted`,
	);
	return { deleted: Number(rows[0]?.deleted ?? 0) };
}

/** Delete a bounded batch of fleet_actions ledger rows past the retention window. Returns rows deleted. */
export async function gcFleetActions(db: Db): Promise<{ deleted: number }> {
	const rows = await db.execute<{ deleted: number }>(
		sql`select public.gc_fleet_actions(make_interval(days => ${FLEET_ACTION_RETENTION_DAYS}), ${GC_BATCH_LIMIT}) as deleted`,
	);
	return { deleted: Number(rows[0]?.deleted ?? 0) };
}

/** Delete a bounded batch of authz_activity_log rows past the retention window. Returns rows deleted. */
export async function gcAuthzActivityLog(db: Db): Promise<{ deleted: number }> {
	const rows = await db.execute<{ deleted: number }>(
		sql`select public.gc_authz_activity_log(make_interval(days => ${AUTHZ_ACTIVITY_RETENTION_DAYS}), ${GC_BATCH_LIMIT}) as deleted`,
	);
	return { deleted: Number(rows[0]?.deleted ?? 0) };
}

/**
 * How long a support case is kept after the matter closes (the Privacy Policy's "up to 3 years").
 * Read from the retention register, with no env override: the published window is the enforced one.
 */
export const SUPPORT_CASE_RETENTION_DAYS = RETENTION_DEFAULT_DAYS.supportCases;

/**
 * When a case's matter closed: its latest `closed_at` if it is closed, its latest `resolved_at` if it
 * is resolved (each falls back to `updated_at`, which every status change stamps, for a row whose
 * stamp is missing) — or its last message, when that is later. Keyed on the CURRENT status because
 * a reopen does not clear the old stamp: a case closed, reopened and then resolved still carries the
 * first `closed_at`, and that is not when this matter closed.
 */
const supportCaseClosedAt: SQL = sql`greatest(
	case ${supportCases.status}
		when 'closed' then coalesce(${supportCases.closed_at}, ${supportCases.updated_at})
		else coalesce(${supportCases.resolved_at}, ${supportCases.updated_at})
	end,
	${supportCases.last_message_at}
)`;

/**
 * A settled case (resolved or closed) whose matter closed more than the window ago, on the
 * database's clock. Typed `SQL`, not `and()`'s `SQL | undefined`: an undefined predicate would make
 * the delete below unconditional. An open or pending case never matches, however old.
 */
const supportCaseExpired: SQL = sql`${inArray(supportCases.status, ["resolved", "closed"])} and ${supportCaseClosedAt} <= now() - make_interval(days => ${SUPPORT_CASE_RETENTION_DAYS})`;

/** The paging bounds of one support-case sweep. */
export interface SupportCaseSweepBounds {
	/** Cases per page (one transaction each). */
	pageSize: number;
	/** Pages per run; a larger backlog drains over later runs. */
	maxPages: number;
}

/** Up to 1,000 cases a run per app instance: a backlog is rare, and each case may hold files. */
const SUPPORT_CASE_BOUNDS: SupportCaseSweepBounds = { pageSize: 100, maxPages: 10 };

/** What one support-case sweep did — counts only, assignable to the heartbeat's result shape. */
export type SupportCaseSweepResult = {
	/** Cases deleted, with their messages, read markers and attachment rows (by cascade). */
	deleted: number;
	/** Attachment files deleted from storage. */
	filesDeleted: number;
	/** Cases kept this run because one of their files could not be deleted; retried next run. */
	storageFailed: number;
};

/**
 * Deletes one page of expired support cases. Locks the page first (`FOR UPDATE SKIP LOCKED`, so a
 * second instance skips it) and names only the locked ids in the delete, with the predicate repeated
 * — the shape `lib/elench/drafts-sweep.ts` documents, because a `DELETE … WHERE id IN (SELECT … LIMIT
 * n SKIP LOCKED)` can delete more than one page. Each case's attachment files are deleted from
 * storage BEFORE its rows: a case with a file that will not delete is kept, so its row still names
 * the file and a later run retries it, rather than deleting the only record of a file that stays.
 * Deleting a missing file is a no-op, so a retry is safe. Returns the page's counts and how many
 * cases it locked.
 */
async function deleteSupportCasePage(
	db: Db,
	pageSize: number,
	files: Pick<StorageBackend, "del">,
): Promise<SupportCaseSweepResult & { locked: number }> {
	return db.transaction(async (tx) => {
		const locked = await tx
			.select({ id: supportCases.id })
			.from(supportCases)
			.where(supportCaseExpired)
			.orderBy(asc(supportCases.created_at))
			.limit(pageSize)
			.for("update", { skipLocked: true });
		if (locked.length === 0) return { deleted: 0, filesDeleted: 0, storageFailed: 0, locked: 0 };
		const ids = locked.map((r) => r.id);

		const attachments = await tx
			.select({ caseId: supportCaseAttachments.case_id, key: supportCaseAttachments.storage_key })
			.from(supportCaseAttachments)
			.where(inArray(supportCaseAttachments.case_id, ids));
		const kept = new Set<string>();
		let filesDeleted = 0;
		for (const file of attachments) {
			if (kept.has(file.caseId)) continue;
			try {
				await files.del(SUPPORT_ATTACHMENTS_BUCKET, file.key);
				filesDeleted++;
			} catch {
				kept.add(file.caseId);
			}
		}

		const doomed = ids.filter((id) => !kept.has(id));
		let deleted = 0;
		if (doomed.length > 0) {
			await tx
				.delete(classificationAssignment)
				.where(
					and(
						eq(classificationAssignment.resource_kind, "support_case"),
						inArray(classificationAssignment.resource_id, doomed),
					),
				);
			const gone = await tx
				.delete(supportCases)
				.where(and(inArray(supportCases.id, doomed), supportCaseExpired))
				.returning({ id: supportCases.id });
			deleted = gone.length;
		}
		return { deleted, filesDeleted, storageFailed: kept.size, locked: locked.length };
	});
}

/**
 * Deletes support cases whose matter closed more than {@link SUPPORT_CASE_RETENTION_DAYS} ago —
 * the case, its messages (internal notes included), its read markers, its attachment rows and files,
 * and its classification assignments. Service role, global: the sweep acts on every org's cases and
 * touches only rows whose own timestamps have passed. Runs page by page up to the bounds, and stops
 * early when a page comes back short (drained) or when a file could not be deleted — storage that is
 * failing would fail every page the same way, and the next run retries.
 */
export async function gcSupportCases(
	db: Db,
	files: Pick<StorageBackend, "del"> = storage,
	bounds: SupportCaseSweepBounds = SUPPORT_CASE_BOUNDS,
): Promise<SupportCaseSweepResult> {
	const total: SupportCaseSweepResult = { deleted: 0, filesDeleted: 0, storageFailed: 0 };
	for (let i = 0; i < bounds.maxPages; i++) {
		const page = await deleteSupportCasePage(db, bounds.pageSize, files);
		total.deleted += page.deleted;
		total.filesDeleted += page.filesDeleted;
		total.storageFailed += page.storageFailed;
		if (page.locked < bounds.pageSize || page.storageFailed > 0) break;
	}
	return total;
}
