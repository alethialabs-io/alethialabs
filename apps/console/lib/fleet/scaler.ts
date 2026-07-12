// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet Controller's loop host. A sibling to the stale-job recovery loop: each app
// instance runs the 60s tick (idempotent + convergent, so concurrent replicas are
// safe). Also runs on demand (wakeFleetController) when a job is enqueued. Default
// (no FLEET_POOLS) → no-op. See dataroom/spec/mvp/26.

import { reconcileAll, type SurplusState } from "@/lib/fleet/controller";
import { makeDbDeps } from "@/lib/fleet/db-deps";
import { loadFleetPools } from "@/lib/fleet/pools-db";
import { getFleetProvider } from "@/lib/fleet/provider";
import {
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";
import { log } from "@/lib/observability/log";
import { sweepBootstrapTokens } from "@/lib/runners/bootstrap-token";

const flog = log.child({ component: "fleet" });

const TICK_INTERVAL_MS = 60_000;

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const FLEET_LOOP_ID = "fleet-scaler";

const globalForScaler = globalThis as unknown as {
	__alethiaFleetScaler?: ReturnType<typeof setInterval>;
};

const surplus: SurplusState = new Map();

/** Starts the periodic fleet controller. Pools now live in the DB (read fresh each tick),
 *  so the loop runs whenever a database is configured — a tick with zero enabled pools is
 *  a cheap no-op, but newly-created pools converge without a restart. Each tick is
 *  heartbeat-supervised (lib/observability/heartbeats.ts). */
export function startFleetScaler(): void {
	if (globalForScaler.__alethiaFleetScaler) return;
	if (!process.env.ALETHIA_DATABASE_URL) return;

	registerLoop(FLEET_LOOP_ID, { intervalMs: TICK_INTERVAL_MS });
	globalForScaler.__alethiaFleetScaler = setInterval(() => {
		void superviseLoop(FLEET_LOOP_ID, tick);
	}, TICK_INTERVAL_MS);
}

/** Run one reconcile pass immediately (enqueue wake / presence / pool edit → fast converge). */
export function wakeFleetScaler(): void {
	if (!globalForScaler.__alethiaFleetScaler) return;
	void superviseLoop(FLEET_LOOP_ID, tick);
}

async function tick(): Promise<void> {
	const projects = await loadFleetPools();
	await reconcileAll(projects, getFleetProvider(), makeDbDeps(), surplus);
	// Best-effort GC of spent/expired per-VM bootstrap tokens (past a retry grace).
	await sweepBootstrapTokens().catch((err) =>
		flog.error("bootstrap-token sweep failed", { err }),
	);
}
