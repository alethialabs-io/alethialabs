// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared helpers for the integration suite: a one-time connectivity probe (so the suite
// SKIPS rather than fails when the dev Postgres isn't up) plus tiny seed helpers. Seeding goes
// through getServiceDb() (bypasses RLS); tests use unique ids and clean up after themselves.

import { type SQL, sql } from "drizzle-orm";
import postgres from "postgres";
import { describe } from "vitest";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, runners } from "@/lib/db/schema";

/** Probe the dev DB once; true when reachable. */
async function ping(): Promise<boolean> {
	try {
		const sql = postgres(process.env.ALETHIA_DATABASE_URL ?? "", {
			max: 1,
			idle_timeout: 1,
			connect_timeout: 3,
		});
		await sql`select 1`;
		await sql.end({ timeout: 1 });
		return true;
	} catch {
		return false;
	}
}

// Top-level await: resolves once per test file (cheap). Gates the whole suite.
export const DB_UP = await ping();

if (!DB_UP) {
	// eslint-disable-next-line no-console
	console.warn(
		"\n[integration] Postgres not reachable on ALETHIA_DATABASE_URL — skipping. Run `pnpm db:up` first.\n",
	);
}

/** `describe` that no-ops when the DB is down, so CI/dev without the stack stays green. */
export const describeIfDb = DB_UP ? describe : describe.skip;

/**
 * Deletes authz_activity_log rows matching `where`, under the retention-GC WORM exemption. The
 * append-only WORM trigger (authz_activity_log_worm in programmables.sql) blocks EVERY direct DELETE
 * except while `app.authz_gc = 'on'` — the flag only gc_authz_activity_log sets. Test teardown is
 * legitimate maintenance, so set that flag for the txn (exactly as the GC does) and then delete.
 * Without this the WORM raises and the suite's cleanup fails.
 */
export async function purgeAuthzActivityLog(where: SQL): Promise<void> {
	await getServiceDb().transaction(async (tx) => {
		await tx.execute(sql`select set_config('app.authz_gc', 'on', true)`);
		await tx.delete(authzActivityLog).where(where);
	});
}

/** Inserts a managed runner (the FK target for jobs / usage sessions) and returns its id. */
export async function seedManagedRunner(name: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			name,
			operator: "managed", // managed ⇒ user_id NULL (CHECK)
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id });
	return row.id;
}
