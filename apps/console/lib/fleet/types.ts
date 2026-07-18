// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared types for the Fleet Controller (dataroom/spec/mvp/26). One declarative pool project is
// reconciled against observed reality across four axes — count, version, health,
// placement — by the pure planner (plan.ts), over immutable VMs driven through the
// FleetProvider primitives.

import type { CloudProvider, HetznerLocation } from "@/lib/db/schema";

/** Declarative desired state for one managed warm pool. */
export interface FleetTarget {
	/** Target cloud the runners provision into (a Hetzner box runs runner-aws to serve AWS). */
	provider: CloudProvider;
	/** Always-warm floor (auto-grow lifts the effective floor toward recent peak). */
	warmMin: number;
	/** Hard ceiling on instances. */
	max: number;
	/** Concurrent jobs one runner handles; divides backlog into runner demand. */
	slotsPerRunner: number;
	/** Locations to spread across (≥1); e.g. ["fsn1","nbg1"]. */
	locations: HetznerLocation[];
	/** Minimum healthy instances to keep in each listed location. */
	minPerLocation: number;
	/** Max extra instances allowed above the floor during a rollout (maxSurge). */
	surge: number;
	/** Headroom added over observed demand so an idle spare always exists (N+1). */
	buffer: number;
	/** Consecutive ticks an instance must be surplus before idle scale-down. */
	scaleDownGraceTicks: number;
	/** Target image/version every instance should run; null = don't version-reconcile.
	 *  Resolved by the controller from `channel` (→ latest release) when set. */
	targetVersion: string | null;
	/** Release channel (e.g. "stable") the controller resolves to the newest release each
	 *  tick; ignored when an explicit `version` pin is configured. */
	channel: string | null;
	/** TEARDOWN mode: this pool is being deleted or is paused, so the planner reconciles its
	 *  target to zero and destroys EVERY instance (version-agnostic) rather than scaling. Undefined
	 *  for all normal pools → normal scaling is byte-identical. Set by `loadFleetPools` for rows
	 *  whose `deleting` flag is set (or that are paused / not enabled). */
	teardown?: boolean;
}

/** What the cloud knows about one VM (returned by FleetProvider.list). */
export interface ProviderInstance {
	instanceId: string;
	location: string;
	/** Image/version the VM was launched with (from a label); null if unknown. */
	version: string | null;
	/** Seconds since the VM was created — lets the planner apply a boot grace. */
	ageSeconds: number;
}

/** A provider instance joined with its correlated DB runner state (controller-built). */
export interface ObservedInstance extends ProviderInstance {
	/** Correlated runner row id (by metadata.cloud_instance_id); null = not yet registered. */
	runnerId: string | null;
	/** DB runner status, or "none" when no runner row is correlated yet. */
	status: "online" | "draining" | "offline" | "none";
	/** Has an in-flight (CLAIMED/PROCESSING) job — never destroy while true. */
	busy: boolean;
}

/** Everything the planner needs to decide the next safe step for a pool. */
export interface Observed {
	instances: ObservedInstance[];
	/** Demand-driving backlog for this provider: the DISPATCHABLE (cap-aware) QUEUED count — jobs a
	 *  runner could claim now given per-org plan caps — so the planner never sizes to work the caps
	 *  block. (The controller passes raw queue depth only to the ledger/telemetry, not here.) */
	backlog: number;
	/** Recent peak concurrent demand (drives auto-grow of the warm floor). */
	recentPeak: number;
	/** Boot grace: a registration-less instance younger than this is "booting", not dead. */
	bootGraceSeconds: number;
	/** Consecutive ticks the pool has been over target — gates idle scale-down (hysteresis). */
	surplusTicks: number;
}

/** Why the planner emitted an action — recorded verbatim onto the fleet_actions ledger so an
 *  operator can reconstruct why the fleet grew/shrank at 3am. Each maps to a branch in plan.ts. */
export type FleetActionReason =
	| "scale-up-demand" // create: bring live capacity up to the demand-driven target
	| "min-per-location" // create: satisfy a per-location floor
	| "rollout-surge" // create: surge a replacement up during a version rollout
	| "rollout-drain" // drain: retire an outdated instance during a version rollout
	| "reap-dead" // destroy: a dead / never-registered (past boot-grace) instance
	| "reap-drained" // destroy: a drained instance whose in-flight job has finished
	| "scale-down-idle" // destroy: idle surplus past the scale-down grace window
	| "teardown"; // drain/destroy: the pool is being deleted or paused → drain to zero (version-agnostic)

/** Minimal, idempotent actions the controller applies to converge toward the project. Each carries
 *  the `reason` it was emitted for, which the controller records to the fleet_actions ledger. */
export type FleetAction =
	| { type: "create"; location: string; version: string | null; reason: FleetActionReason }
	| { type: "drain"; runnerId: string; instanceId: string; reason: FleetActionReason }
	| { type: "destroy"; instanceId: string; reason: FleetActionReason };

/**
 * Cloud capacity primitives. The controller owns all diff logic; the provider just
 * lists/creates/destroys VMs. Real clouds (Hetzner) + the manual no-op + the test fake
 * implement this. See dataroom/spec/mvp/26.
 */
export interface FleetProvider {
	list(project: FleetTarget): Promise<ProviderInstance[]>;
	/** `bootstrapToken` is the per-VM E0-0b token the controller minted for this VM (injected into
	 *  its cloud-init). Required by cloud providers that provision a VM; ignored by the manual no-op. */
	create(
		project: FleetTarget,
		opts: { location: string; version: string | null; bootstrapToken?: string },
	): Promise<void>;
	destroy(instanceId: string): Promise<void>;
}
