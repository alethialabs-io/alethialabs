// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";

// In-app replacement for the AWS-Lambda cron that requeued stale jobs. Each app
// instance runs the interval; recover_stale_jobs() is idempotent (FOR UPDATE
// SKIP LOCKED semantics make concurrent runs across instances safe), so the
// self-host bundle needs no Lambda. See spec/mvp/06-self-hosting-architecture.md.

const RECOVERY_INTERVAL_MS = 60_000;

const globalForRecovery = globalThis as unknown as {
	__alethiaJobRecovery?: ReturnType<typeof setInterval>;
};

/** Starts the periodic stale-job recovery sweep (idempotent across HMR/instances). */
export function startStaleJobRecovery(): void {
	if (globalForRecovery.__alethiaJobRecovery) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	globalForRecovery.__alethiaJobRecovery = setInterval(() => {
		void getServiceDb()
			.execute(sql`select recover_stale_jobs()`)
			.catch((err) => {
				console.error("[job-recovery] recover_stale_jobs failed:", err);
			});
	}, RECOVERY_INTERVAL_MS);
}
