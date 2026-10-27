// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/cost — the latest priced picture of a project environment (the
// Infracost breakdown a PLAN captured). Defaults to the project's default environment; pass
// ?env= to target another. Gated on project `view`; org-scoped via an explicit projects.org_id
// filter (RLS is bypassed here). Mirrors getLatestEnvironmentCost (web).

import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import {
	resolveCliEnvironment,
	resolveCliProject,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { environmentCost, projects } from "@/lib/db/schema";
import { cliCostResponse } from "@/lib/validations/cli-contract";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;
	const envParam = new URL(req.url).searchParams.get("env");

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		let environmentId: string | null;
		let environmentName: string | null = null;
		if (envParam) {
			const env = await resolveCliEnvironment(project.id, envParam);
			if (!env) {
				return NextResponse.json(
					{ error: `Environment "${envParam}" not found` },
					{ status: 404 },
				);
			}
			environmentId = env.id;
			environmentName = env.name;
		} else {
			environmentId = await resolveDefaultEnvironmentId(project.id);
		}

		const unpriced = {
			priced: false,
			total_monthly: null,
			currency: "USD",
			captured_at: null,
			plan_job_id: null,
			environment: environmentName,
			resources: [],
		};
		if (!environmentId) return cliJson(cliCostResponse, unpriced);

		const db = getServiceDb();
		const [row] = await db
			.select({
				total_monthly: environmentCost.total_monthly,
				currency: environmentCost.currency,
				resources: environmentCost.resources,
				captured_at: environmentCost.captured_at,
				plan_job_id: environmentCost.plan_job_id,
			})
			.from(environmentCost)
			.innerJoin(projects, eq(environmentCost.project_id, projects.id))
			.where(
				and(
					eq(environmentCost.project_id, project.id),
					eq(environmentCost.environment_id, environmentId),
					eq(projects.org_id, actor.orgId),
				),
			)
			.orderBy(desc(environmentCost.captured_at))
			.limit(1);

		if (!row) return cliJson(cliCostResponse, unpriced);

		return cliJson(cliCostResponse, {
			priced: true,
			total_monthly: row.total_monthly,
			currency: row.currency,
			captured_at: row.captured_at.toISOString(),
			plan_job_id: row.plan_job_id,
			environment: environmentName,
			resources: (row.resources ?? []).map((r) => ({
				address: r.address,
				resource_type: r.resourceType,
				monthly_cost: r.monthlyCost,
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
