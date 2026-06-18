// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/config/database";
import * as schema from "./schema";

type Db = PostgresJsDatabase<typeof schema>;

// Cache the postgres-js clients + drizzle instances across HMR / module reloads.
const globalForDb = globalThis as unknown as {
	__alethiaServiceDb?: Db;
	__alethiaAppDb?: Db;
};

/** Builds a pooler-safe postgres-js client (prepare:false → transaction-pooler compatible). */
function makeClient(url: string) {
	const cfg = getDatabaseConfig();
	return postgres(url, {
		max: cfg.poolMax,
		idle_timeout: cfg.idleTimeout,
		prepare: false,
	});
}

/**
 * Service connection — bypasses RLS (superuser / BYPASSRLS role). Backs the
 * worker + CLI API routes and the SECURITY DEFINER RPC calls (replaces the
 * Supabase service-role client). Never use for user-facing reads/writes.
 */
export function getServiceDb(): Db {
	if (!globalForDb.__alethiaServiceDb) {
		globalForDb.__alethiaServiceDb = drizzle(
			makeClient(getDatabaseConfig().serviceUrl),
			{ schema, casing: "snake_case" },
		);
	}
	return globalForDb.__alethiaServiceDb;
}

/**
 * App connection — least-privilege role with RLS enforced. Only reachable
 * through withOwnerScope() so a query never runs without the owner set.
 */
function getAppDb(): Db {
	if (!globalForDb.__alethiaAppDb) {
		globalForDb.__alethiaAppDb = drizzle(
			makeClient(getDatabaseConfig().appUrl),
			{ schema, casing: "snake_case" },
		);
	}
	return globalForDb.__alethiaAppDb;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Runs `fn` inside a transaction on the RLS-enforced app connection with
 * `app.current_owner` set to `ownerId` (transaction-scoped via the `true` flag —
 * pooler-safe). This is the single enforcement point for the per-owner RLS
 * backstop: the owner comes from getActiveScope(actor); ee/ Teams later resolves
 * it to an org without touching call sites.
 */
export async function withOwnerScope<T>(
	ownerId: string,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return getAppDb().transaction(async (tx) => {
		await tx.execute(
			sql`select set_config('app.current_owner', ${ownerId}, true)`,
		);
		return fn(tx);
	});
}
