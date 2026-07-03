// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The FleetProvider seam: cloud capacity primitives (list/create/destroy). The
// controller owns ALL diff logic (plan.ts); a provider just lists/creates/destroys
// VMs. `FLEET_PROVIDER=hcloud` provisions real Hetzner VMs; the default `manual`
// provider is a DB-backed no-op for self-host / bring-your-own. See dataroom/spec/mvp/26.

import { getServiceDb } from "@/lib/db";
import type { CloudProvider } from "@/lib/db/schema";
import { getHcloudFleetProvider } from "@/lib/fleet/hcloud";
import type { FleetProvider, FleetTarget, ProviderInstance } from "@/lib/fleet/types";
import { sql } from "drizzle-orm";

export type { FleetProvider, FleetTarget, ProviderInstance } from "@/lib/fleet/types";

type ManualRow = { instance_id: string; location: string | null; version: string | null };

/**
 * Default provider for self-host / "operator runs the workers": instances ARE the
 * managed runners (1:1); create/destroy just log the desired signal (no auto-provision).
 */
class ManualFleetProvider implements FleetProvider {
	async list(project: FleetTarget): Promise<ProviderInstance[]> {
		const rows = await getServiceDb().execute<ManualRow>(sql`
			select coalesce(r.metadata->>'cloud_instance_id', r.id::text) as instance_id,
			       r.location, r.version
			from public.runners r
			where r.operator = 'managed' and r.status <> 'OFFLINE'
			  and (r.supported_providers is null or ${project.provider}::cloud_provider = any(r.supported_providers))
		`);
		return rows.map((r) => ({
			instanceId: r.instance_id,
			location: r.location ?? "",
			version: r.version,
			ageSeconds: Number.POSITIVE_INFINITY, // existing runners are past any boot grace
		}));
	}

	async create(project: FleetTarget, opts: { location: string; version: string | null }): Promise<void> {
		console.log(
			`[fleet] ${project.provider}: would create a runner (loc=${opts.location} ver=${opts.version}) ` +
				`— manual provider, run a worker to match.`,
		);
	}

	async destroy(instanceId: string): Promise<void> {
		console.log(`[fleet] would destroy instance ${instanceId} — manual provider, stop the worker.`);
	}
}

const globalForFleet = globalThis as unknown as {
	__alethiaFleetProvider?: FleetProvider;
};

/** Process-wide fleet provider (seam). Default = manual; `FLEET_PROVIDER=hcloud` = Hetzner. */
export function getFleetProvider(): FleetProvider {
	if (!globalForFleet.__alethiaFleetProvider) {
		globalForFleet.__alethiaFleetProvider =
			process.env.FLEET_PROVIDER === "hcloud"
				? getHcloudFleetProvider()
				: new ManualFleetProvider();
	}
	return globalForFleet.__alethiaFleetProvider;
}

/** For tests: install a specific provider (e.g. the fake). */
export function setFleetProvider(p: FleetProvider): void {
	globalForFleet.__alethiaFleetProvider = p;
}

/** @internal — exported for tests. */
export { ManualFleetProvider };
export type { CloudProvider };
