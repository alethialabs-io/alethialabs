// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, specs } from "@/lib/db/schema";
import { NextResponse } from "next/server";

/**
 * Lists the CLI user's specs as ConfigurationSummary rows. Wire-locked: emits
 * the frozen summary keys (`vineyard_id`←zone_id, `cloud_provider`←identity
 * provider) that the CLI `configurations list` command parses.
 */
export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload.sub;
	if (!userId) {
		return NextResponse.json({ error: "Invalid token payload" }, { status: 400 });
	}

	try {
		const rows = await getServiceDb()
			.select({
				id: specs.id,
				project_name: specs.project_name,
				vineyard_id: specs.zone_id,
				environment_stage: specs.environment_stage,
				status: specs.status,
				region: specs.region,
				cloud_provider: cloudIdentities.provider,
				estimated_monthly_cost: specs.estimated_monthly_cost,
				created_at: specs.created_at,
				updated_at: specs.updated_at,
			})
			.from(specs)
			.leftJoin(cloudIdentities, eq(specs.cloud_identity_id, cloudIdentities.id))
			.where(eq(specs.user_id, userId))
			.orderBy(desc(specs.created_at));

		const configurations = rows.map((r) => ({
			...r,
			cloud_provider: r.cloud_provider ?? "",
		}));

		return NextResponse.json({ configurations });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
