// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, inArray } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { specEnvironments, specs, zones } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliZoneResponse, cliZonesResponse } from "@/lib/validations/cli-contract";

/**
 * Lists the CLI user's zones with their nested specs. Wire-locked: the CLI
 * parses the `zones`/`specs` shape, so the renamed columns
 * (zones/specs) are mapped back to the frozen JSON keys here.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "zone" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const db = getServiceDb();

	const zoneRows = await db
		.select()
		.from(zones)
		.where(eq(zones.org_id, actor.orgId))
		.orderBy(desc(zones.created_at));

	const zoneIds = zoneRows.map((z) => z.id);
	const specRows = zoneIds.length
		? await db
				.select({
					id: specs.id,
					project_name: specs.project_name,
					// M1: environment + status from the spec's default environment.
					environment_stage: specEnvironments.name,
					status: specEnvironments.status,
					region: specs.region,
					zone_id: specs.zone_id,
				})
				.from(specs)
				.leftJoin(
					specEnvironments,
					and(
						eq(specEnvironments.spec_id, specs.id),
						eq(specEnvironments.is_default, true),
					),
				)
				.where(inArray(specs.zone_id, zoneIds))
		: [];

	// Frozen wire shape: each zone carries a nested `specs` array.
	const zoneList = zoneRows.map((z) => ({
		id: z.id,
		user_id: z.user_id,
		name: z.name,
		description: z.description,
		created_at: z.created_at,
		updated_at: z.updated_at,
		specs: specRows
			.filter((s) => s.zone_id === z.id)
			.map(({ zone_id: _zone_id, ...spec }) => ({
				...spec,
				environment_stage: spec.environment_stage ?? "development",
				status: spec.status ?? "DRAFT",
			})),
	}));

	return cliJson(cliZonesResponse, { zones: zoneList });
}

/** Creates a new zone for the CLI user. */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "create", { type: "zone" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const body = await req.json();

		if (!body.name) {
			return new Response(JSON.stringify({ error: "Name is required" }), {
				status: 400,
			});
		}

		const [zone] = await getServiceDb()
			.insert(zones)
			.values({
				user_id: actor.userId,
				name: body.name,
				description: body.description || null,
			})
			.returning();

		return cliJson(cliZoneResponse, { zone });
	} catch (_e) {
		return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
			status: 400,
		});
	}
}
