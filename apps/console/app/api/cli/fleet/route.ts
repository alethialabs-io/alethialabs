// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asc } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import { getServiceDb } from "@/lib/db";
import { fleetPools } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliFleetPoolsResponse } from "@/lib/validations/cli-contract";

/**
 * True only on self-managed deployments. The managed warm-pool fleet (`fleet_pools`) is
 * GLOBAL platform-operator config (no org_id), so on the hosted SaaS no tenant operates it
 * — exposing it would leak our fleet topology + COGS. On self-managed the operator IS the
 * customer, so their org's owner/admin may read/edit it (the PDP `fleet` resource gate).
 */
export function isFleetOperatorDeployment(): boolean {
	return deploymentMode() === "self-managed";
}

/** Maps a fleet_pools row to its client-safe CLI wire shape (mirrors fleetPoolWire). */
export function toFleetPoolWire(row: typeof fleetPools.$inferSelect) {
	return {
		provider: row.provider,
		warm_min: row.warm_min,
		max: row.max,
		slots_per_runner: row.slots_per_runner,
		locations: row.locations,
		surge: row.surge,
		buffer: row.buffer,
		channel: row.channel,
		version: row.version,
		enabled: row.enabled,
	};
}

/**
 * Lists the managed fleet's warm pools (one per provider). Gated on `view` of the global
 * `fleet` resource (owner/admin/viewer); only reachable on self-managed deployments —
 * hosted tenants get an empty list rather than the platform's fleet topology.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "fleet" });
	if ("error" in auth) return auth.error;

	try {
		// Hosted tenants don't operate the managed fleet — show nothing, not our topology.
		if (!isFleetOperatorDeployment()) {
			return cliJson(cliFleetPoolsResponse, { pools: [] });
		}
		const rows = await getServiceDb()
			.select()
			.from(fleetPools)
			.orderBy(asc(fleetPools.provider));
		return cliJson(cliFleetPoolsResponse, { pools: rows.map(toFleetPoolWire) });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
