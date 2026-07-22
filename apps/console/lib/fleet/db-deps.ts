// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Production ControllerDeps — wires the controller's injected DB hooks to the real
// queries. Kept separate from controller.ts so the controller stays DB-free + testable.

import type { ControllerDeps } from "@/lib/fleet/controller";
import {
	backlogByProvider,
	countInflightForProvider,
	countLiveManagedInstances,
	disableFleetPool,
	dispatchableBacklogByProvider,
	insertFleetAction,
	latestReleaseVersion,
	managedRunnersByInstance,
	markRunnerDraining,
	recentReapDeadCount,
	retireRunner,
	setRunnerObserved,
	tryFleetScaleLock,
} from "@/lib/fleet/queue";
import { mintBootstrapToken } from "@/lib/runners/bootstrap-token";

const BOOT_GRACE_SECONDS =
	Number.parseInt(process.env.FLEET_BOOT_GRACE_SECONDS ?? "180", 10) || 180;

// Circuit-breaker (INCIDENT 2026-07-22): pause a pool after this many `reap-dead` boot failures
// within the look-back window — a zero-registration loop the scaler would otherwise churn forever.
const BOOT_FAILURE_LIMIT =
	Number.parseInt(process.env.FLEET_BOOT_FAILURE_LIMIT ?? "5", 10) || 5;
const BOOT_FAILURE_WINDOW_MIN =
	Number.parseInt(process.env.FLEET_BOOT_FAILURE_WINDOW_MIN ?? "30", 10) || 30;

/** Global fleet instance ceiling (max total managed VMs across all pools) from the environment;
 *  null (unset / non-positive) = no ceiling. A COGS backstop above each pool's `max`. */
function fleetInstanceCeiling(): number | null {
	const raw = Number.parseInt(process.env.FLEET_MAX_TOTAL_INSTANCES ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** The live (Postgres-backed) controller deps. */
export function makeDbDeps(): ControllerDeps {
	return {
		runnerMap: (provider) => managedRunnersByInstance(provider),
		backlog: async (provider) => (await backlogByProvider()).get(provider) ?? 0,
		dispatchableBacklog: async (provider) =>
			(await dispatchableBacklogByProvider()).get(provider) ?? 0,
		recentPeak: (provider) => countInflightForProvider(provider),
		globalInstanceCeiling: () => fleetInstanceCeiling(),
		liveManagedInstances: () => countLiveManagedInstances(),
		resolveChannel: () => latestReleaseVersion(),
		drain: (runnerId) => markRunnerDraining(runnerId),
		retire: (runnerId) => retireRunner(runnerId),
		persistObserved: (runnerId, patch) =>
			setRunnerObserved(runnerId, patch.location, patch.version),
		bootGraceSeconds: BOOT_GRACE_SECONDS,
		mintBootstrapToken: () => mintBootstrapToken(),
		recordAction: (record) => insertFleetAction(record),
		recentBootFailures: (provider, windowMin) => recentReapDeadCount(provider, windowMin),
		disablePool: (provider) => disableFleetPool(provider),
		bootFailureLimit: BOOT_FAILURE_LIMIT,
		bootFailureWindowMin: BOOT_FAILURE_WINDOW_MIN,
		withScaleLock: (provider, apply) => tryFleetScaleLock(provider, apply),
	};
}
