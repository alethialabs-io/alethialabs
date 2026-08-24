// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Retention GC wired into the supervised reconcile loop. Thin wrappers over the bounded-batch GC
// programmables (gc_job_logs / gc_fleet_actions in programmables.sql) — the SQL does the deleting
// (FOR UPDATE SKIP LOCKED, capped at a batch size so it never table-locks); these just call it with
// the configured retention window and surface the deleted count for the heartbeat. Best-effort: the
// loop already isolates a throw per task, so a GC hiccup never blocks the other reconcilers.

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { RETENTION_DEFAULT_DAYS } from "@/lib/retention/registry";

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
