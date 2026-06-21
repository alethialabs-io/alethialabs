// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { computeDesired } from "@/lib/fleet/compute-desired";
import { getFleetPools } from "@/lib/fleet/config";
import { getFleetProvider, type Pool } from "@/lib/fleet/provider";
import { backlogByProvider } from "@/lib/fleet/queue";

// In-app fleet scaler. A sibling to the stale-job recovery loop: each app instance
// runs the 60s tick; the FleetProvider's scale() must be idempotent (converge to
// desired), so concurrent instances are safe. Cloud-agnostic — see spec/mvp/20 §2.

const SCALER_INTERVAL_MS = 60_000;

const globalForScaler = globalThis as unknown as {
	__alethiaFleetScaler?: ReturnType<typeof setInterval>;
};

// Per-provider hysteresis state (in-process; re-derived from current/backlog on restart).
const idleTicks = new Map<string, number>();
let activePools: Pool[] = [];

/** Starts the periodic fleet scaler. No pools configured → no-op (default). */
export function startFleetScaler(): void {
	if (globalForScaler.__alethiaFleetScaler) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB yet
	activePools = getFleetPools();
	if (activePools.length === 0) return; // nothing to scale — stay a no-op

	globalForScaler.__alethiaFleetScaler = setInterval(() => {
		void tick();
	}, SCALER_INTERVAL_MS);
}

/** Run one scaling pass immediately (used by notifyScaler on enqueue for fast scale-up). */
export function wakeFleetScaler(): void {
	if (!globalForScaler.__alethiaFleetScaler) return; // not running / no pools
	void tick();
}

async function tick(): Promise<void> {
	try {
		const backlog = await backlogByProvider();
		const provider = getFleetProvider();
		for (const pool of activePools) {
			// Provider-less ("any") jobs are claimable by any warm runner; the warmMin
			// floor covers them, so they don't drive per-pool scale-up.
			const queued = backlog.get(pool.provider) ?? 0;
			const current = await provider.current(pool);
			const prev = idleTicks.get(pool.provider) ?? 0;
			const { desired, idleTicks: next } = computeDesired(queued, current, pool, prev);
			idleTicks.set(pool.provider, next);
			if (desired !== current) await provider.scale(pool, desired);
		}
	} catch (err) {
		console.error("[fleet] scaler tick failed:", err);
	}
}
