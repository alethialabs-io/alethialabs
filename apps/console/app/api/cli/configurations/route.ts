// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, projectEnvironments, projects } from "@/lib/db/schema";
import { NextResponse } from "next/server";

/**
 * Lists the CLI user's projects as ConfigurationSummary rows. Wire-locked: emits
 * the frozen summary keys (e.g. `cloud_provider` ← identity provider) that the CLI
 * `configurations list` command parses.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select({
				id: projects.id,
				project_name: projects.project_name,
				// M1: environment + status from the project's default environment.
				environment_stage: projectEnvironments.name,
				status: projectEnvironments.status,
				region: projects.region,
				cloud_provider: cloudIdentities.provider,
				estimated_monthly_cost: projects.estimated_monthly_cost,
				created_at: projects.created_at,
				updated_at: projects.updated_at,
			})
			.from(projects)
			.leftJoin(cloudIdentities, eq(projects.cloud_identity_id, cloudIdentities.id))
			.leftJoin(
				projectEnvironments,
				and(
					eq(projectEnvironments.project_id, projects.id),
					eq(projectEnvironments.is_default, true),
				),
			)
			.where(eq(projects.org_id, actor.orgId))
			.orderBy(desc(projects.created_at));

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
