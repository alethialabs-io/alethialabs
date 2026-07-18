// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The impure half of the Fleet Controller: gather observed reality, call the pure
// planner (plan.ts), apply the resulting actions. All DB/cloud access is injected via
// `ControllerDeps` so the whole reconcile is unit-testable in-memory against a fake
// world (no Postgres, no Hetzner). See dataroom/spec/mvp/26.

import { plan, targetCount } from "@/lib/fleet/plan";
import type {
	FleetAction,
	FleetActionReason,
	FleetProvider,
	FleetTarget,
	ObservedInstance,
} from "@/lib/fleet/types";
import type { CloudProvider } from "@/lib/db/schema";
import type { FleetActionMetadata } from "@/types/jsonb.types";

/** One durable fleet-action record the controller appends to the fleet_actions ledger — the WHY
 *  behind a create/drain/destroy, plus the decision inputs (queue depth + observed pool size). */
export interface FleetActionRecord {
	provider: CloudProvider;
	action: FleetAction["type"];
	reason: FleetActionReason;
	/** Correlated runner (drain/destroy); null for a create (its runner self-registers later). */
	runnerId: string | null;
	/** QUEUED backlog for the provider at decision time. */
	queueDepth: number;
	/** Observed online (claimable) pool size at decision time. */
	poolSize: number;
	metadata?: FleetActionMetadata;
}
import { log } from "@/lib/observability/log";
import {
	recordFleetSize,
	recordQueueDepth,
	recordScalerAction,
} from "@/lib/observability/metrics";
import { captureServerException } from "@/lib/analytics/server";

const flog = log.child({ component: "fleet" });

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
	/** Mints + records a per-VM bootstrap token (E0 0b); returns the plaintext for the VM cloud-init. */
	mintBootstrapToken(): Promise<string>;
	/** Append one row to the durable fleet_actions ledger (why a VM was created/drained/destroyed).
	 *  Best-effort by contract — the controller wraps every call so a ledger write can NEVER break a
	 *  reconcile (the ledger is observability, not a correctness dependency). */
	recordAction(record: FleetActionRecord): Promise<void>;
	/**
	 * Cross-replica scale guard: run `apply` (the create/drain/destroy span for one provider's pool)
	 * while holding a per-provider Postgres advisory lock, so at most ONE replica mutates a given
	 * provider's pool per tick. Two replicas that each read "pool below target" and both create would
	 * over-provision (up to R× VMs) — there is no DB lock on the create side otherwise. Returns true
	 * if the lock was acquired (`apply` ran to completion); false if another replica already holds it
	 * this tick (`apply` was NOT run — the caller no-ops). With a single replica the lock is always
	 * free ⇒ always acquired ⇒ behaviour identical to pre-lock. Injected so the controller stays
	 * DB-free + unit-testable (fakes just run `apply` and return true).
	 */
	withScaleLock(provider: string, apply: () => Promise<void>): Promise<boolean>;
}

/** Per-provider hysteresis carried across ticks (surplus-over-target counter). */
export type SurplusState = Map<string, number>;

/**
 * Reconcile one pool toward its project exactly once: resolve the target version, build
 * the observed view (provider.list ⨝ runner state), plan, and apply. Returns the
 * actions taken (for logging/tests).
 */
export async function reconcilePool(
	project: FleetTarget,
	provider: FleetProvider,
	deps: ControllerDeps,
	surplus: SurplusState,
): Promise<number> {
	// Resolve channel → target version (a pin wins; set on the project the planner sees).
	let targetVersion = project.targetVersion;
	if (targetVersion === null && project.channel) {
		targetVersion = await deps.resolveChannel(project.channel);
	}
	const resolved: FleetTarget = { ...project, targetVersion };

	const [instances, rmap, backlog, recentPeak] = await Promise.all([
		provider.list(resolved),
		deps.runnerMap(project.provider),
		deps.backlog(project.provider),
		deps.recentPeak(project.provider),
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
			.filter((o): o is (typeof observedInstances)[number] & { runnerId: string } => o.runnerId !== null && Boolean(o.location))
			.map((o) =>
				deps
					.persistObserved(o.runnerId, { location: o.location, version: o.version })
					.catch((err) =>
						flog.error("persistObserved failed", {
							instance_id: o.instanceId,
							err,
						}),
					),
			),
	);

	const target = targetCount(resolved, backlog, recentPeak);
	const onlineNow = observedInstances.filter((i) => i.status === "online").length;
	const surplusTicks = onlineNow > target ? (surplus.get(project.provider) ?? 0) + 1 : 0;
	surplus.set(project.provider, surplusTicks);

	// Telemetry (no-op unless an OTLP endpoint is configured): sample the per-provider
	// queue depth + online fleet size each tick. Labels are the low-cardinality provider
	// only — never a job_id / runner_id.
	recordQueueDepth(project.provider, backlog);
	recordFleetSize(project.provider, onlineNow);

	const actions = plan(resolved, {
		instances: observedInstances,
		backlog,
		recentPeak,
		bootGraceSeconds: deps.bootGraceSeconds,
		surplusTicks,
	});

	const byInstance = new Map(observedInstances.map((i) => [i.instanceId, i]));

	/** Append one ledger row, best-effort: a fleet_actions write must NEVER break a reconcile. */
	const record = async (
		a: FleetAction,
		runnerId: string | null,
		metadata: FleetActionMetadata,
	): Promise<void> => {
		await deps
			.recordAction({
				provider: project.provider,
				action: a.type,
				reason: a.reason,
				runnerId,
				queueDepth: backlog,
				poolSize: onlineNow,
				metadata,
			})
			.catch((err) => console.error("[fleet] recordAction failed:", err));
	};

	// Nothing to mutate this tick → no need to contend the scale lock (a pure no-op read pass, which
	// every replica may run freely). The reads/telemetry/persistObserved above are idempotent.
	if (actions.length === 0) return 0;

	// Cross-replica guard: only ONE replica applies a given provider's create/drain/destroy per tick.
	// A losing replica (another holds the lock this tick) skips the mutate span entirely — it does NOT
	// wait+re-read a stale snapshot, so there is no sequential double-fire. The winner holds the lock
	// (a Postgres advisory xact lock) across this pool's create calls until its tx commits. Single
	// replica ⇒ lock always free ⇒ identical to pre-lock behaviour.
	const acquired = await deps.withScaleLock(project.provider, async () => {
		for (const a of actions) {
			// Count the scaler action (no-op unless telemetry is on) — provider + action only.
			recordScalerAction(project.provider, a.type);
			if (a.type === "create") {
				// Mint + record this VM's own short-TTL bootstrap token, then inject it into its
				// cloud-init (never a shared secret) — so a metadata-leaked token is bounded to this VM.
				const bootstrapToken = await deps.mintBootstrapToken();
				try {
					await provider.create(resolved, {
						location: a.location,
						version: a.version,
						bootstrapToken,
					});
				} catch (err) {
					// "Why couldn't the fleet place a VM?" — a create rejection (quota, an exhausted
					// SKU/arch: the Hetzner 412 that stalled prod for days) is the exact signal that
					// used to be invisible: it aborted the tick and surfaced only as a generic
					// "reconcile failed". Count it, surface it with the full decision context, and do
					// NOT let one bad VM abort the pool's other convergence (drains/reaps that free
					// capacity) — continue; the next tick re-plans and retries the create.
					recordScalerAction(project.provider, "create-failed");
					flog.error("fleet provision failed — could not place a VM", {
						provider: project.provider,
						location: a.location,
						version: a.version,
						reason: a.reason,
						queue_depth: backlog,
						pool_size: onlineNow,
						err,
					});
					// Best-effort PostHog Error-tracking event; no-ops without the analytics key and
					// never throws. Carries only low-sensitivity placement context (no token/secret).
					void captureServerException(err, {
						props: {
							area: "fleet",
							provider: project.provider,
							location: a.location,
							version: a.version ?? undefined,
							reason: a.reason,
							queue_depth: backlog,
							pool_size: onlineNow,
						},
					});
					continue;
				}
				await record(a, null, { location: a.location, version: a.version });
			} else if (a.type === "drain") {
				await deps.drain(a.runnerId);
				await record(a, a.runnerId, { instance_id: a.instanceId });
			} else {
				await provider.destroy(a.instanceId);
				const runnerId = byInstance.get(a.instanceId)?.runnerId ?? null;
				if (runnerId) await deps.retire(runnerId);
				await record(a, runnerId, {
					instance_id: a.instanceId,
					location: byInstance.get(a.instanceId)?.location,
				});
			}
		}
	});

	if (!acquired) {
		// Another replica owns this provider's scaling this tick → we no-op. Convergence still holds:
		// the holder applies now, and the next tick re-reads the (now up-to-date) pool.
		flog.info("scale lock held by another replica; skipping apply", {
			provider: project.provider,
			actions: actions.length,
		});
		return 0;
	}
	return actions.length;
}

/** Reconcile every configured pool (one controller tick). */
export async function reconcileAll(
	projects: FleetTarget[],
	provider: FleetProvider,
	deps: ControllerDeps,
	surplus: SurplusState,
): Promise<void> {
	for (const project of projects) {
		try {
			await reconcilePool(project, provider, deps, surplus);
		} catch (err) {
			flog.error("reconcile failed", { provider: project.provider, err });
		}
	}
}
