// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet Controller's loop host. A sibling to the stale-job recovery loop: each app
// instance runs the 60s tick (idempotent + convergent, so concurrent replicas are
// safe). Also runs on demand (wakeFleetController) when a job is enqueued. Default
// (no FLEET_POOLS) → no-op. See spec/mvp/26.

import { getFleetPools } from "@/lib/fleet/config";
import { reconcileAll, type SurplusState } from "@/lib/fleet/controller";
import { makeDbDeps } from "@/lib/fleet/db-deps";
import { getFleetProvider } from "@/lib/fleet/provider";
import type { FleetSpec } from "@/lib/fleet/types";

const TICK_INTERVAL_MS = 60_000;

const globalForScaler = globalThis as unknown as {
	__alethiaFleetScaler?: ReturnType<typeof setInterval>;
};

const surplus: SurplusState = new Map();
let activeSpecs: FleetSpec[] = [];

/** Starts the periodic fleet controller. No pools configured → no-op (default). */
export function startFleetScaler(): void {
	if (globalForScaler.__alethiaFleetScaler) return;
	if (!process.env.ALETHIA_DATABASE_URL) return;
	activeSpecs = getFleetPools();
	if (activeSpecs.length === 0) return;

	globalForScaler.__alethiaFleetScaler = setInterval(() => {
		void tick();
	}, TICK_INTERVAL_MS);
}

/** Run one reconcile pass immediately (enqueue wake / presence events → fast scale-up). */
export function wakeFleetScaler(): void {
	if (!globalForScaler.__alethiaFleetScaler) return;
	void tick();
}

async function tick(): Promise<void> {
	await reconcileAll(activeSpecs, getFleetProvider(), makeDbDeps(), surplus);
}
