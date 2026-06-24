// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The impure half of the Fleet Controller: gather observed reality, call the pure
// planner (plan.ts), apply the resulting actions. All DB/cloud access is injected via
// `ControllerDeps` so the whole reconcile is unit-testable in-memory against a fake
// world (no Postgres, no Hetzner). See dataroom/spec/mvp/26.

import { plan, targetCount } from "@/lib/fleet/plan";
import type {
	FleetProvider,
	FleetSpec,
	ObservedInstance,
} from "@/lib/fleet/types";

/** Runner-side state correlated to a cloud instance (by metadata.cloud_instance_id). */
export interface RunnerState {
	runnerId: string;
	status: "online" | "draining" | "offline";
	version: string | null;
	busy: boolean;
}

/** Everything the controller needs from the DB — injected so it's fakeable in tests. */
export interface ControllerDeps {
	/** instanceId → correlated managed-runner state. */
	runnerMap(provider: string): Promise<Map<string, RunnerState>>;
	/** QUEUED jobs targeting this provider. */
	backlog(provider: string): Promise<number>;
	/** Current in-flight (CLAIMED/PROCESSING) jobs — drives auto-grow of the warm floor. */
	recentPeak(provider: string): Promise<number>;
	/** Newest released version for a channel (or null if none). */
	resolveChannel(channel: string): Promise<string | null>;
	/** Mark a runner DRAINING (stops it claiming → goes idle → reaped). */
	drain(runnerId: string): Promise<void>;
	/** Mark a removed runner OFFLINE + close its usage session. */
	retire(runnerId: string): Promise<void>;
	/** Persist the cloud-observed placement (location) + launch version onto the runner row,
	 *  so the Fleet cockpit can show where each managed runner runs. Version only backfills
	 *  when unset (the runner's own heartbeat-reported version wins). */
	persistObserved(runnerId: string, patch: { location: string; version: string | null }): Promise<void>;
	/** A registration-less instance younger than this is "booting", not dead. */
	bootGraceSeconds: number;
}

/** Per-provider hysteresis carried across ticks (surplus-over-target counter). */
export type SurplusState = Map<string, number>;

/**
 * Reconcile one pool toward its spec exactly once: resolve the target version, build
 * the observed view (provider.list ⨝ runner state), plan, and apply. Returns the
 * actions taken (for logging/tests).
 */
export async function reconcilePool(
	spec: FleetSpec,
	provider: FleetProvider,
	deps: ControllerDeps,
	surplus: SurplusState,
): Promise<number> {
	// Resolve channel → target version (a pin wins; set on the spec the planner sees).
	let targetVersion = spec.targetVersion;
	if (targetVersion === null && spec.channel) {
		targetVersion = await deps.resolveChannel(spec.channel);
	}
	const resolved: FleetSpec = { ...spec, targetVersion };

	const [instances, rmap, backlog, recentPeak] = await Promise.all([
		provider.list(resolved),
		deps.runnerMap(spec.provider),
		deps.backlog(spec.provider),
		deps.recentPeak(spec.provider),
	]);

	const observedInstances: ObservedInstance[] = instances.map((pi) => {
		const r = rmap.get(pi.instanceId);
		return {
			...pi,
			version: r?.version ?? pi.version,
			runnerId: r?.runnerId ?? null,
			status: r ? r.status : "none",
			busy: r?.busy ?? false,
		};
	});

	// Persist the cloud-observed placement onto correlated runner rows (best-effort, so a
	// write hiccup never blocks reconciliation). Lets the Fleet cockpit show where runners run.
	await Promise.all(
		observedInstances
			.filter((o) => o.runnerId !== null && o.location)
			.map((o) =>
				deps
					.persistObserved(o.runnerId as string, { location: o.location, version: o.version })
					.catch((err) => console.error(`[fleet] persistObserved ${o.instanceId} failed:`, err)),
			),
	);

	const target = targetCount(resolved, backlog, recentPeak);
	const onlineNow = observedInstances.filter((i) => i.status === "online").length;
	const surplusTicks = onlineNow > target ? (surplus.get(spec.provider) ?? 0) + 1 : 0;
	surplus.set(spec.provider, surplusTicks);

	const actions = plan(resolved, {
		instances: observedInstances,
		backlog,
		recentPeak,
		bootGraceSeconds: deps.bootGraceSeconds,
		surplusTicks,
	});

	const byInstance = new Map(observedInstances.map((i) => [i.instanceId, i]));
	for (const a of actions) {
		if (a.type === "create") {
			await provider.create(resolved, { location: a.location, version: a.version });
		} else if (a.type === "drain") {
			await deps.drain(a.runnerId);
		} else {
			await provider.destroy(a.instanceId);
			const runnerId = byInstance.get(a.instanceId)?.runnerId;
			if (runnerId) await deps.retire(runnerId);
		}
	}
	return actions.length;
}

/** Reconcile every configured pool (one controller tick). */
export async function reconcileAll(
	specs: FleetSpec[],
	provider: FleetProvider,
	deps: ControllerDeps,
	surplus: SurplusState,
): Promise<void> {
	for (const spec of specs) {
		try {
			await reconcilePool(spec, provider, deps, surplus);
		} catch (err) {
			console.error(`[fleet] reconcile failed for ${spec.provider}:`, err);
		}
	}
}
