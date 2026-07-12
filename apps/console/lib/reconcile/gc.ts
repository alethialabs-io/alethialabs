// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Retention GC wired into the supervised reconcile loop. Thin wrappers over the bounded-batch GC
// programmables (gc_job_logs / gc_fleet_actions in programmables.sql) — the SQL does the deleting
// (FOR UPDATE SKIP LOCKED, capped at a batch size so it never table-locks); these just call it with
// the configured retention window and surface the deleted count for the heartbeat. Best-effort: the
// loop already isolates a throw per task, so a GC hiccup never blocks the other reconcilers.

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";

/** Retention window (days) for job_logs before they're GC'd. Override via env; default 30d. */
const JOB_LOG_RETENTION_DAYS = Number(
	process.env.ALETHIA_JOB_LOG_RETENTION_DAYS ?? "30",
);
/** Retention window (days) for the fleet_actions ledger. Override via env; default 90d. */
const FLEET_ACTION_RETENTION_DAYS = Number(
	process.env.ALETHIA_FLEET_ACTION_RETENTION_DAYS ?? "90",
);
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
