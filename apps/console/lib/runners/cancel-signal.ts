// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";

/**
 * Signals the runner that owns an in-flight job to cancel it mid-flight. Emits a
 * `runner_cancel` pg_notify carrying { runner_id, job_id }; the console app instance
 * holding that runner's wake SSE connection (getCancelTransport) forwards it as a typed
 * cancel event to that runner only, which cancels the job's context (SIGINT-first tofu
 * teardown). Fire-and-forget: cancellation is delivered by the DB flip to CANCELLED
 * regardless, so a notify failure must never fail the cancel action. Runs on the service
 * DB (bypasses RLS) since the routing decision was already authorized upstream.
 */
export async function notifyRunnerCancel(
	runnerId: string,
	jobId: string,
): Promise<void> {
	await getServiceDb().execute(
		sql`select pg_notify('runner_cancel', json_build_object('runner_id', ${runnerId}::text, 'job_id', ${jobId}::text)::text)`,
	);
}
