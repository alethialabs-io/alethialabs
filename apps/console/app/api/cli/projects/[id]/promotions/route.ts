// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/promotions — the project's environment promotions (source → target),
// optionally scoped to one target environment. Gated on project `view`; org-scoped via an explicit
// projects.org_id filter (RLS bypassed here). Mirrors listPromotions (web).

import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliEnvironment, resolveCliProject } from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { environmentPromotions, projectEnvironments, projects } from "@/lib/db/schema";
import { cliPromotionsResponse } from "@/lib/validations/cli-contract";

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

		let targetEnvId: string | null = null;
		if (envParam) {
			const env = await resolveCliEnvironment(project.id, envParam);
			if (!env) {
				return NextResponse.json(
					{ error: `Environment "${envParam}" not found` },
					{ status: 404 },
				);
			}
			targetEnvId = env.id;
		}

		const srcEnv = alias(projectEnvironments, "src_env");
		const tgtEnv = alias(projectEnvironments, "tgt_env");
		const db = getServiceDb();
		const rows = await db
			.select({
				id: environmentPromotions.id,
				source: srcEnv.name,
				target: tgtEnv.name,
				status: environmentPromotions.status,
				error_message: environmentPromotions.error_message,
				created_at: environmentPromotions.created_at,
				completed_at: environmentPromotions.completed_at,
			})
			.from(environmentPromotions)
			.innerJoin(projects, eq(environmentPromotions.project_id, projects.id))
			.leftJoin(srcEnv, eq(environmentPromotions.source_environment_id, srcEnv.id))
			.leftJoin(tgtEnv, eq(environmentPromotions.target_environment_id, tgtEnv.id))
			.where(
				and(
					eq(environmentPromotions.project_id, project.id),
					eq(projects.org_id, actor.orgId),
					...(targetEnvId
						? [eq(environmentPromotions.target_environment_id, targetEnvId)]
						: []),
				),
			)
			.orderBy(desc(environmentPromotions.created_at));

		return cliJson(cliPromotionsResponse, {
			promotions: rows.map((r) => ({
				id: r.id,
				source: r.source ?? "—",
				target: r.target ?? "—",
				status: r.status,
				error_message: r.error_message,
				created_at: r.created_at.toISOString(),
				completed_at: r.completed_at?.toISOString() ?? null,
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
