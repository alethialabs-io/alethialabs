// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared types for the Fleet Controller (spec/mvp/26). One declarative pool spec is
// reconciled against observed reality across four axes — count, version, health,
// placement — by the pure planner (plan.ts), over immutable VMs driven through the
// FleetProvider primitives.

import type { CloudProvider } from "@/lib/db/schema";

/** Declarative desired state for one managed warm pool. */
export interface FleetSpec {
	/** Target cloud the runners provision into (a Hetzner box runs runner-aws to serve AWS). */
	provider: CloudProvider;
	/** Always-warm floor (auto-grow lifts the effective floor toward recent peak). */
	warmMin: number;
	/** Hard ceiling on instances. */
	max: number;
	/** Concurrent jobs one runner handles; divides backlog into runner demand. */
	slotsPerRunner: number;
	/** Locations to spread across (≥1); e.g. ["fsn1","nbg1"]. */
	locations: string[];
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
	/** QUEUED jobs targeting this provider. */
	backlog: number;
	/** Recent peak concurrent demand (drives auto-grow of the warm floor). */
	recentPeak: number;
	/** Boot grace: a registration-less instance younger than this is "booting", not dead. */
	bootGraceSeconds: number;
	/** Consecutive ticks the pool has been over target — gates idle scale-down (hysteresis). */
	surplusTicks: number;
}

/** Minimal, idempotent actions the controller applies to converge toward the spec. */
export type FleetAction =
	| { type: "create"; location: string; version: string | null }
	| { type: "drain"; runnerId: string; instanceId: string }
	| { type: "destroy"; instanceId: string };

/**
 * Cloud capacity primitives. The controller owns all diff logic; the provider just
 * lists/creates/destroys VMs. Real clouds (Hetzner) + the manual no-op + the test fake
 * implement this. See spec/mvp/26.
 */
export interface FleetProvider {
	list(spec: FleetSpec): Promise<ProviderInstance[]>;
	create(spec: FleetSpec, opts: { location: string; version: string | null }): Promise<void>;
	destroy(instanceId: string): Promise<void>;
}
