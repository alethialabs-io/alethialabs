// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The capability refresh task (epic #928 / #938) — the reliable backstop beneath the on-connect sync and
// the (later Tier-2, #978) event nudge. It re-runs each connection's capability enumeration when it is due,
// with bounded concurrency, so account-accurate offerings stay fresh and connections that were never synced
// (made before this shipped) get backfilled. The EXPENSIVE per-region work is short-circuited inside the
// lanes by the hash gate (capabilities/sync-state.ts); this sweep only decides WHICH identities to re-run.
//
// `capabilities_synced_at` is both the freshness clock and the Tier-2 dirty sentinel: an invalidation event
// sets it NULL, which counts as due here — so the next tick re-enumerates that connection. Mirrors the
// connection sweeper (lib/cloud-providers/sweep.ts): globalThis singleton, per-row cross-replica claim,
// heartbeat-supervised ticks, and an internal cron route for hosted. No runner, no jobs.

import { and, eq, lt, ne, or, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { registerLoop, superviseLoop } from "@/lib/observability/heartbeats";
import {
	gcRemovedCapabilities,
	hasServerSideCapabilities,
	syncCloudCapabilities,
} from "./index";

/** How long a soft-removed capability row (an offering withdrawn in-cloud) is kept before it's purged. */
const RETENTION_DAYS = Number(
	process.env.ALETHIA_CAPABILITY_RETENTION_DAYS ?? "7",
);
/** Outer staleness backstop — the per-region hash gate in the lanes is the real change-detector, so a due
 * connection's tick is cheap when nothing moved. Capabilities change slowly, so this is generous. */
const CAPABILITY_TTL = sql`interval '24 hours'`;
/** Max connections refreshed per sweep tick (keeps a tick bounded; the next tick continues). */
const BATCH = 20;
/** Concurrent refreshes within a tick. */
const CONCURRENCY = 4;

/** Selects connections whose capability catalog is stale (or never synced) and that have a server-side
 * enumeration lane. Service-role read (no tenant scope) — the sweep is a platform job. A `pending` row is a
 * dangling connect-sheet placeholder (empty credentials), so it's excluded — enumerating it would fail. */
async function dueCapabilities() {
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
				ne(cloudIdentities.status, "pending"),
				or(
					// NULL counts as due so the Tier-2 (#978) event-NULL nudge is honored on the next tick.
					sql`${cloudIdentities.capabilities_synced_at} is null`,
					lt(
						cloudIdentities.capabilities_synced_at,
						sql`now() - ${CAPABILITY_TTL}`,
					),
				),
			),
		)
		.limit(BATCH);
}

/**
 * Cross-replica claim: atomically flip `capabilities_synced_at` to now() for this identity, but only if it
 * is still due by the TTL (or never synced / event-nulled). Exactly the replica whose UPDATE flips the
 * timestamp gets a row back (→ it owns the refresh this tick); a racing replica matches zero rows and skips.
 * The dispatcher re-stamps on success; a failed enumeration therefore backs off the full TTL (best-effort —
 * the on-connect hook covers fresh connects).
 */
export async function claimDueCapability(id: string): Promise<boolean> {
	const claimed = await getServiceDb()
		.update(cloudIdentities)
		.set({ capabilities_synced_at: new Date() })
		.where(
			and(
				eq(cloudIdentities.id, id),
				or(
					sql`${cloudIdentities.capabilities_synced_at} is null`,
					lt(
						cloudIdentities.capabilities_synced_at,
						sql`now() - ${CAPABILITY_TTL}`,
					),
				),
			),
		)
		.returning({ id: cloudIdentities.id });
	return claimed.length > 0;
}

/** Runs one sweep tick: refresh up to BATCH due connections' capability catalogs. Returns counts. */
export async function runCapabilitySweep(): Promise<{
	checked: number;
	synced: number;
}> {
	// Retention GC: drop soft-removed rows past the window (best-effort; never blocks the refresh).
	await gcRemovedCapabilities(RETENTION_DAYS).catch(() => 0);

	const due = await dueCapabilities();
	let synced = 0;

	// Bounded concurrency.
	for (let i = 0; i < due.length; i += CONCURRENCY) {
		const slice = due.slice(i, i + CONCURRENCY);
		await Promise.all(
			slice.map(async (identity) => {
				// No enumeration lane → skip (don't claim, so we never stamp a connection we can't sync).
				if (!hasServerSideCapabilities(identity.provider)) return;
				// Claim before enumerating: only the replica that flips capabilities_synced_at proceeds;
				// others skip this connection this tick (no duplicate cloud API calls across replicas).
				if (!(await claimDueCapability(identity.id))) return;
				// Best-effort — syncCloudCapabilities never throws and re-stamps freshness on success.
				await syncCloudCapabilities(identity);
				synced += 1;
			}),
		);
	}

	return { checked: due.length, synced };
}

/** Tick cadence — the per-connection TTL gates the actual work, so a short tick just picks up whoever is
 * due (and backfills any connection that was never synced). */
const SWEEP_INTERVAL_MS = 60_000;

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const CAPABILITY_SWEEPER_LOOP_ID = "capability-sweeper";

declare global {
	var __alethiaCapabilitySweeper: ReturnType<typeof setInterval> | undefined;
}

/**
 * Starts the periodic capability refresh in-process (idempotent across HMR/instances) — the reliable
 * backstop that keeps the per-tenant capabilities catalog fresh and backfills connections that were never
 * synced. Sibling to `startConnectionSweeper`. Each tick is heartbeat-supervised so /health sees it ticking.
 * The `/api/internal/capabilities/sweep` route stays available for an external cron on hosted.
 */
export function startCapabilitySweeper(): void {
	if (globalThis.__alethiaCapabilitySweeper) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	registerLoop(CAPABILITY_SWEEPER_LOOP_ID, { intervalMs: SWEEP_INTERVAL_MS });
	globalThis.__alethiaCapabilitySweeper = setInterval(() => {
		void superviseLoop(CAPABILITY_SWEEPER_LOOP_ID, runCapabilitySweep);
	}, SWEEP_INTERVAL_MS);
}
