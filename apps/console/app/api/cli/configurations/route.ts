// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, specEnvironments, specs } from "@/lib/db/schema";
import { NextResponse } from "next/server";

/**
 * Lists the CLI user's specs as ConfigurationSummary rows. Wire-locked: emits
 * the frozen summary keys (`zone_id`, `cloud_provider`←identity
 * provider) that the CLI `configurations list` command parses.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "spec" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select({
				id: specs.id,
				project_name: specs.project_name,
				zone_id: specs.zone_id,
				// M1: environment + status from the spec's default environment.
				environment_stage: specEnvironments.name,
				status: specEnvironments.status,
				region: specs.region,
				cloud_provider: cloudIdentities.provider,
				estimated_monthly_cost: specs.estimated_monthly_cost,
				created_at: specs.created_at,
				updated_at: specs.updated_at,
			})
			.from(specs)
			.leftJoin(cloudIdentities, eq(specs.cloud_identity_id, cloudIdentities.id))
			.leftJoin(
				specEnvironments,
				and(
					eq(specEnvironments.spec_id, specs.id),
					eq(specEnvironments.is_default, true),
				),
			)
			.where(eq(specs.org_id, actor.orgId))
			.orderBy(desc(specs.created_at));

		const configurations = rows.map((r) => ({
			...r,
			environment_stage: r.environment_stage ?? "development",
			status: r.status ?? "DRAFT",
			cloud_provider: r.cloud_provider ?? "",
		}));

		return NextResponse.json({ configurations });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
