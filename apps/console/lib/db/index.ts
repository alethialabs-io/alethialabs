// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/config/database";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

// Cache the postgres-js clients + drizzle instances across HMR / module reloads.
declare global {
	var __alethiaServiceDb: Db | undefined;
	var __alethiaAppDb: Db | undefined;
}

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
 * runner + CLI API routes and the SECURITY DEFINER RPC calls. Never use for user-facing reads/writes.
 */
export function getServiceDb(): Db {
	if (!globalThis.__alethiaServiceDb) {
		globalThis.__alethiaServiceDb = drizzle(
			makeClient(getDatabaseConfig().serviceUrl),
			{ schema, casing: "snake_case" },
		);
	}
	return globalThis.__alethiaServiceDb;
}

/**
 * App connection — least-privilege role with RLS enforced. Only reachable
 * through withOwnerScope() so a query never runs without the owner set.
 */
function getAppDb(): Db {
	if (!globalThis.__alethiaAppDb) {
		globalThis.__alethiaAppDb = drizzle(
			makeClient(getDatabaseConfig().appUrl),
			{ schema, casing: "snake_case" },
		);
	}
	return globalThis.__alethiaAppDb;
}

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Active tenancy scope. Community: `orgId === ownerId` (personal org). */
export interface Scope {
	ownerId: string;
	orgId: string;
}

/**
 * Runs `fn` inside a transaction on the RLS-enforced app connection with both
 * `app.current_owner` and `app.current_org` set (transaction-scoped via the `true`
 * flag — pooler-safe). The org var drives the coarse-org RLS blast wall; the owner
 * var drives the per-owner policy. This is the single enforcement point; the scope
 * comes from getActiveScope(actor) (community personal org; ee/ Teams resolves a
 * real organization without touching call sites).
 */
export async function withScope<T>(
	scope: Scope,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return getAppDb().transaction(async (tx) => {
		await tx.execute(
			sql`select set_config('app.current_owner', ${scope.ownerId}, true), set_config('app.current_org', ${scope.orgId}, true)`,
		);
		return fn(tx);
	});
}

/**
 * Personal-scope wrapper: scopes to the owner's *personal* org (`orgId === ownerId`).
 *
 * ⚠️ This forces `app.current_org = ownerId` (the user id), NOT the actor's real active
 * org — so in a Teams/enterprise org (`actor.orgId !== actor.userId`) it sees only rows
 * the current user personally created and is BLIND to org-shared rows. Use it ONLY for
 * genuinely user-private data. For any org-shared resource (projects, jobs, clusters,
 * runners, …) use {@link withActorScope} so RLS carries the real active org.
 */
export async function withOwnerScope<T>(
	ownerId: string,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return withScope({ ownerId, orgId: ownerId }, fn);
}

/**
 * Actor-scope wrapper — the standard for org-shared reads/writes. Scopes to the actor's
 * userId (owner var) AND real active orgId (org var), so the coarse-org RLS wall
 * (`org_id = app.current_org`) resolves to the true organization. In community/personal
 * scope `actor.orgId === actor.userId`, so this is identical to {@link withOwnerScope}.
 * Accepts a structural `{ userId, orgId }` (usually the {@link Actor} from currentActor())
 * to keep this low-level module dependency-free.
 */
export async function withActorScope<T>(
	actor: { userId: string; orgId: string },
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, fn);
}
