// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getServiceDb } from "@/lib/db";
import { verifyPlatformSecret } from "@/lib/platform/auth";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Queue-depth probe for the ECS scaler. Requeues stale jobs, then reports how
 * many jobs are QUEUED so the scaler can scale this node's runner service up or
 * down. Authenticated with the
 * shared platform secret (Bearer RELEASE_API_SECRET).
 */
export async function POST(req: Request) {
	const unauthorized = verifyPlatformSecret(req);
	if (unauthorized) return unauthorized;

	const db = getServiceDb();

	// recover_stale_jobs() resets jobs abandoned by a dead runner back to QUEUED.
	const recoveredRows = await db.execute<{ recover_stale_jobs: number }>(
		sql`SELECT public.recover_stale_jobs()`,
	);
	const recovered = Number(recoveredRows[0]?.recover_stale_jobs ?? 0);

	// sweep_offline_runners() flips dead runners to OFFLINE and closes their open
	// usage sessions so managed-runner provisioned hours stop accruing promptly.
	await db
		.execute(sql`SELECT public.sweep_offline_runners()`)
		.catch((err) => {
			console.error("[platform/queue] sweep_offline_runners failed:", err);
		});

	const queuedRows = await db.execute<{ queued: number }>(
		sql`SELECT count(*)::int AS queued FROM jobs WHERE status = 'QUEUED'`,
	);
	const queued = Number(queuedRows[0]?.queued ?? 0);

	return NextResponse.json({ recovered, queued });
}
