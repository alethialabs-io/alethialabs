// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProvider } from "@/lib/db/schema";
import type { PoolConfig } from "@/lib/fleet/compute-desired";
import { getHcloudFleetProvider } from "@/lib/fleet/hcloud";
import { countManagedRunnersForProvider } from "@/lib/fleet/queue";

/** A scalable pool: a cloud provider's managed warm capacity + its scaling knobs. */
export interface Pool extends PoolConfig {
	provider: CloudProvider;
}

/**
 * Cloud-agnostic capacity backend. The scaler loop only ever talks to this — real
 * clouds (Hetzner hcloud, AWS ECS, GCP MIG, …) implement it later behind
 * getFleetProvider(), and the loop never changes. See spec/mvp/20 §2.
 */
export interface FleetProvider {
	/** Running runner instances currently in the pool. */
	current(pool: Pool): Promise<number>;
	/** Converge the pool to `desired` instances. */
	scale(pool: Pool, desired: number): Promise<void>;
}

/**
 * Default, cloud-agnostic provider for self-host and any "operator runs the workers"
 * deployment: reports current capacity from the DB and records the desired signal
 * without provisioning (no cloud coupling). Swapped for a real provider via config/ee.
 */
class ManualFleetProvider implements FleetProvider {
	async current(pool: Pool): Promise<number> {
		return countManagedRunnersForProvider(pool.provider);
	}

	async scale(pool: Pool, desired: number): Promise<void> {
		const current = await this.current(pool);
		if (desired !== current) {
			console.log(
				`[fleet] ${pool.provider}: target=${desired} current=${current} ` +
					`(manual provider — no auto-provision; run/stop workers to match)`,
			);
		}
	}
}

const globalForFleet = globalThis as unknown as {
	__alethiaFleetProvider?: FleetProvider;
};

/**
 * Process-wide fleet provider (seam). `FLEET_PROVIDER=hcloud` provisions real Hetzner
 * VMs; the default `manual` provider is a DB-counted no-op (self-host / bring-your-own).
 */
export function getFleetProvider(): FleetProvider {
	if (!globalForFleet.__alethiaFleetProvider) {
		globalForFleet.__alethiaFleetProvider =
			process.env.FLEET_PROVIDER === "hcloud"
				? getHcloudFleetProvider()
				: new ManualFleetProvider();
	}
	return globalForFleet.__alethiaFleetProvider;
}
