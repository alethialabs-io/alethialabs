// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The background refresh task — re-verifies health + re-syncs inventory for connections that are due,
// with bounded concurrency. Driven by a cron (hosted) / interval (self-host) hitting the internal
// route. This is the reliable backstop beneath the on-connect sync and the (later) event ingester:
// it catches revoked access (→ DISCONNECTED), missed events, and resources deleted in-cloud
// (soft-removed). No runner, no jobs.

import { and, eq, lt, ne, or, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import {
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";
import {
	gcRemovedQuotaCapabilities,
	hasServerSideQuotaCapabilities,
	syncCloudQuotaCapabilities,
} from "./capabilities/quotas-index";
import {
	gcRemovedServiceCapabilities,
	hasServerSideServiceCapabilities,
	syncCloudServiceCapabilities,
} from "./capabilities/services-index";
import { canProbeHealth, probeHealth } from "./health";
import {
	gcRemovedInventory,
	hasServerSideInventory,
	syncCloudInventory,
} from "./inventory";

/** How long a soft-removed inventory row (a resource deleted in-cloud) is kept before it's purged. */
const RETENTION_DAYS = Number(process.env.ALETHIA_INVENTORY_RETENTION_DAYS ?? "7");

/** How stale a connection's health / inventory may be before the sweep refreshes it. */
const HEALTH_TTL = sql`interval '10 minutes'`;
const INVENTORY_TTL = sql`interval '1 hour'`;
/** Max connections refreshed per sweep tick (keeps a tick bounded; the next tick continues). */
const BATCH = 20;
/** Concurrent refreshes within a tick. */
const CONCURRENCY = 4;

/** Selects connections whose health or inventory is stale (or never run) and that have a server-side
 * path. Service-role read (no tenant scope) — the sweep is a platform job. */
async function dueConnections() {
	const db = getServiceDb();
	return db
		.select({
			id: cloudIdentities.id,
			provider: cloudIdentities.provider,
			credentials: cloudIdentities.credentials,
		})
		.from(cloudIdentities)
		.where(
			and(
				// Never probe a `pending` row: it's a dangling connect-sheet placeholder created by
				// initIdentity with empty credentials and no submitted account. Probing it would fail
				// (no role/token) and poison it to `disconnected`, surfacing a phantom "Verification
				// failed" for a provider the user never attempted. A real submit sets status→'testing'
				// first, so genuine connections are still swept.
				ne(cloudIdentities.status, "pending"),
				// Any submitted connection whose health/inventory is stale. `probeHealth` returns null
				// for providers without a server-side path (self-managed) → the sweep skips them, so no
				// provider filter is needed here.
				or(
					sql`${cloudIdentities.last_tested_at} is null`,
					lt(cloudIdentities.last_tested_at, sql`now() - ${HEALTH_TTL}`),
					sql`${cloudIdentities.inventory_synced_at} is null`,
					lt(cloudIdentities.inventory_synced_at, sql`now() - ${INVENTORY_TTL}`),
				),
			),
		)
		.limit(BATCH);
}

/**
 * Cross-replica claim: atomically flip `last_tested_at` to now() for this identity, but only if it is
 * still due by the health TTL (or never tested). Exactly the replica whose UPDATE flips the timestamp
 * gets a row back (→ it owns the probe this tick); a racing replica's UPDATE matches zero rows and it
 * skips — so a connection is probed by ONE replica per TTL window, not every replica (duplicate cloud
 * API calls / rate-limit risk). Claiming here (not only in persistHealth) also rate-limits retries: a
 * transient probe failure now waits out the TTL instead of being re-hit every tick.
 */
export async function claimDueConnection(id: string): Promise<boolean> {
	const claimed = await getServiceDb()
		.update(cloudIdentities)
		.set({ last_tested_at: new Date() })
		.where(
			and(
				eq(cloudIdentities.id, id),
				or(
					sql`${cloudIdentities.last_tested_at} is null`,
					lt(cloudIdentities.last_tested_at, sql`now() - ${HEALTH_TTL}`),
				),
			),
		)
		.returning({ id: cloudIdentities.id });
	return claimed.length > 0;
}

/** Persists a health probe result onto the identity (status + freshness). */
async function persistHealth(
	identityId: string,
	result: NonNullable<Awaited<ReturnType<typeof probeHealth>>>,
): Promise<void> {
	await getServiceDb()
		.update(cloudIdentities)
		.set({
			is_verified: result.status !== "disconnected",
			status: result.status,
			last_error: result.error,
			last_tested_at: new Date(),
			verified_account_id: result.accountId,
			missing_permissions: result.missingPermissions,
			updated_at: new Date(),
		})
		.where(eq(cloudIdentities.id, identityId));
}

/** Runs one sweep tick: refresh up to BATCH due connections (health then inventory). Returns counts. */
export async function runConnectionSweep(): Promise<{
	checked: number;
	disconnected: number;
}> {
	// Retention GC: drop soft-removed rows past the window (best-effort; never blocks the refresh) —
	// inventory + the Wave-2 capability projections (launchable services + service-quota headroom).
	await gcRemovedInventory(RETENTION_DAYS).catch(() => 0);
	await gcRemovedServiceCapabilities(RETENTION_DAYS).catch(() => 0);
	await gcRemovedQuotaCapabilities(RETENTION_DAYS).catch(() => 0);

	const due = await dueConnections();
	let disconnected = 0;

	// Bounded concurrency.
	for (let i = 0; i < due.length; i += CONCURRENCY) {
		const slice = due.slice(i, i + CONCURRENCY);
		await Promise.all(
			slice.map(async (identity) => {
				// Nothing we can probe → skip (don't claim, so we never stamp last_tested_at on a
				// connection we can't actually test). Credential-aware: a SELF-MANAGED token cloud holds
				// its token customer-side, and the old provider-only check probed it anyway — the probe
				// answered "No API token is stored" and flipped a healthy connection to `disconnected`
				// on every tick.
				if (!canProbeHealth(identity)) return;
				// Claim before probing: only the replica that flips last_tested_at proceeds; others skip
				// this connection this tick (no duplicate cloud API calls across replicas).
				if (!(await claimDueConnection(identity.id))) return;
				const result = await probeHealth(identity).catch(() => null);
				if (result) {
					await persistHealth(identity.id, result);
					if (result.status === "disconnected") disconnected += 1;
					// Only re-inventory while we still have access.
					if (
						result.status !== "disconnected" &&
						hasServerSideInventory(identity.provider)
					) {
						await syncCloudInventory(identity);
					}
					// Refresh the account-accurate capability projections while we still have access
					// (Wave-2: launchable managed services + networking service-quota headroom). Each
					// dispatcher is best-effort (swallows a lane error, never throws) and is gated on the
					// provider having a lane — mirroring the inventory refresh above.
					if (
						result.status !== "disconnected" &&
						hasServerSideServiceCapabilities(identity.provider)
					) {
						await syncCloudServiceCapabilities(identity);
					}
					if (
						result.status !== "disconnected" &&
						hasServerSideQuotaCapabilities(identity.provider)
					) {
						await syncCloudQuotaCapabilities(identity);
					}
				}
			}),
		);
	}

	return { checked: due.length, disconnected };
}

/** Tick cadence — the per-connection TTLs (health 10m, inventory 1h) gate the actual work, so a short
 * tick just picks up whoever is due (and backfills any connection that was never synced). */
const SWEEP_INTERVAL_MS = 60_000;

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const CONNECTION_SWEEPER_LOOP_ID = "connection-sweeper";

declare global {
	var __alethiaConnectionSweeper: ReturnType<typeof setInterval> | undefined;
}

/**
 * Starts the periodic connection sweep in-process (idempotent across HMR/instances) — the reliable
 * backstop that keeps connection health + the asset-inventory baseline fresh and **backfills
 * connections that were never synced** (e.g. made before this shipped). Mirrors `startStaleJobRecovery`.
 * Each tick is heartbeat-supervised (lib/observability/heartbeats.ts) so /health can see it ticking.
 * The `/api/internal/connections/sweep` route stays available for an external cron on hosted.
 */
export function startConnectionSweeper(): void {
	if (globalThis.__alethiaConnectionSweeper) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	registerLoop(CONNECTION_SWEEPER_LOOP_ID, { intervalMs: SWEEP_INTERVAL_MS });
	globalThis.__alethiaConnectionSweeper = setInterval(() => {
		void superviseLoop(CONNECTION_SWEEPER_LOOP_ID, runConnectionSweep);
	}, SWEEP_INTERVAL_MS);
}
