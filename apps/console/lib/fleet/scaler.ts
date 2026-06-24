// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet Controller's loop host. A sibling to the stale-job recovery loop: each app
// instance runs the 60s tick (idempotent + convergent, so concurrent replicas are
// safe). Also runs on demand (wakeFleetController) when a job is enqueued. Default
// (no FLEET_POOLS) → no-op. See dataroom/spec/mvp/26.

import { reconcileAll, type SurplusState } from "@/lib/fleet/controller";
import { makeDbDeps } from "@/lib/fleet/db-deps";
import { loadFleetPools } from "@/lib/fleet/pools-db";
import { getFleetProvider } from "@/lib/fleet/provider";

const TICK_INTERVAL_MS = 60_000;

const globalForScaler = globalThis as unknown as {
	__alethiaFleetScaler?: ReturnType<typeof setInterval>;
};

const surplus: SurplusState = new Map();

/** Starts the periodic fleet controller. Pools now live in the DB (read fresh each tick),
 *  so the loop runs whenever a database is configured — a tick with zero enabled pools is
 *  a cheap no-op, but newly-created pools converge without a restart. */
export function startFleetScaler(): void {
	if (globalForScaler.__alethiaFleetScaler) return;
	if (!process.env.ALETHIA_DATABASE_URL) return;

	globalForScaler.__alethiaFleetScaler = setInterval(() => {
		void tick();
	}, TICK_INTERVAL_MS);
}

/** Run one reconcile pass immediately (enqueue wake / presence / pool edit → fast converge). */
export function wakeFleetScaler(): void {
	if (!globalForScaler.__alethiaFleetScaler) return;
	void tick();
}

async function tick(): Promise<void> {
	const specs = await loadFleetPools();
	await reconcileAll(specs, getFleetProvider(), makeDbDeps(), surplus);
}
