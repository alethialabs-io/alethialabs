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
	var __alethiaLockDb: Db | undefined;
}

/**
 * Builds a pooler-safe postgres-js client (prepare:false → transaction-pooler compatible).
 *
 * CONNECTION BUDGET. Three clients are built here, each with up to `poolMax`
 * (`ALETHIA_DB_POOL_MAX`, default 10) connections: service, app and lock. So one console
 * process can hold up to 3 × `poolMax`, plus the two `max: 1` LISTEN clients in
 * lib/realtime/index.ts. The lock pool opens only while a purchase or a Stripe webhook delivery
 * runs, and closes after `idleTimeout`. The bundled Postgres in docker-compose.yml sets no `max_connections`, so the
 * Postgres default of 100 applies: with the defaults, one console process reaches 32 of them,
 * and the admin app (apps/admin/lib/db.ts) builds pools of its own on top. Several console
 * replicas against one database multiply the 3 × `poolMax`: size `ALETHIA_DB_POOL_MAX` against
 * the database's `max_connections` divided by the replica count.
 */
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
 * Lock connection: the service role, on a pool of its own (`poolMax` connections, created lazily).
 * For a caller that holds a connection open while the code it guards queries through
 * {@link getServiceDb}. It has two callers: `withPurchaseLock` (lib/billing/purchase-lock.ts) holds a
 * transaction here for a whole purchase, and `runWebhookEventExactlyOnce`
 * (lib/billing/webhook-events.ts) holds one for a whole Stripe webhook delivery. Drawn from the service
 * pool, `poolMax` such holders took every service connection and then waited forever for one more,
 * because postgres-js has no acquisition timeout (#6012, #6027). From this pool, a holder never waits on
 * itself: what it guards uses the service pool. The two callers share the pool, so a burst of one can
 * make the other wait for a connection, but neither holds one while asking for another.
 *
 * Code that runs while it holds a connection from here must not take another from here: that would
 * bring the same stall back on this pool. A caller beyond `poolMax` waits for a holder to finish, with
 * no timeout of its own.
 */
export function getLockDb(): Db {
	if (!globalThis.__alethiaLockDb) {
		globalThis.__alethiaLockDb = drizzle(
			makeClient(getDatabaseConfig().serviceUrl),
			{ schema, casing: "snake_case" },
		);
	}
	return globalThis.__alethiaLockDb;
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
