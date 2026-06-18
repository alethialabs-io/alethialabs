// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq, inArray } from "drizzle-orm";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { specs, zones } from "@/lib/db/schema";
import { NextResponse } from "next/server";

/**
 * Lists the CLI user's zones with their nested specs. Wire-locked: the CLI
 * parses the legacy `vineyards`/`vines` shape, so the renamed columns
 * (zones/specs) are mapped back to the frozen JSON keys here.
 */
export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return new Response(JSON.stringify({ error: "Invalid token payload" }), {
			status: 400,
		});
	}

	const db = getServiceDb();

	const zoneRows = await db
		.select()
		.from(zones)
		.where(eq(zones.user_id, userId))
		.orderBy(desc(zones.created_at));

	const zoneIds = zoneRows.map((z) => z.id);
	const specRows = zoneIds.length
		? await db
				.select({
					id: specs.id,
					project_name: specs.project_name,
					environment_stage: specs.environment_stage,
					status: specs.status,
					region: specs.region,
					zone_id: specs.zone_id,
				})
				.from(specs)
				.where(inArray(specs.zone_id, zoneIds))
		: [];

	// Frozen wire shape: each zone carries a nested `vines` array.
	const vineyards = zoneRows.map((z) => ({
		id: z.id,
		user_id: z.user_id,
		name: z.name,
		description: z.description,
		created_at: z.created_at,
		updated_at: z.updated_at,
		vines: specRows
			.filter((s) => s.zone_id === z.id)
			.map(({ zone_id: _zone_id, ...vine }) => vine),
	}));

	return NextResponse.json({ vineyards });
}

/** Creates a new zone for the CLI user (wire name: vineyard). */
export async function POST(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return new Response(JSON.stringify({ error: "Invalid token payload" }), {
			status: 400,
		});
	}

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
				user_id: userId,
				name: body.name,
				description: body.description || null,
			})
			.returning();

		return NextResponse.json({ vineyard: zone });
	} catch (_e) {
		return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
			status: 400,
		});
	}
}
