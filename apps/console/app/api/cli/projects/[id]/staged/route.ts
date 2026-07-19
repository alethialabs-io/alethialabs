// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/staged — an environment's durable staged (pending) canvas changes
// (defaults to the project's default environment; pass ?env= for another). Gated on project
// `view`; org-scoped via an explicit projects.org_id filter (RLS bypassed here). Mirrors
// listStagedChanges (web); the per-change payload delta stays console-only (kind + op + target).

import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import {
	resolveCliEnvironment,
	resolveCliProject,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectChanges, projects } from "@/lib/db/schema";
import { cliStagedChangesResponse } from "@/lib/validations/cli-contract";

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
		let environmentName = "";
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
		if (!environmentId) {
			return cliJson(cliStagedChangesResponse, { environment: environmentName, changes: [] });
		}

		const db = getServiceDb();
		const rows = await db
			.select({
				component_type: projectChanges.component_type,
				op: projectChanges.op,
				component_id: projectChanges.component_id,
				created_at: projectChanges.created_at,
			})
			.from(projectChanges)
			.innerJoin(projects, eq(projectChanges.project_id, projects.id))
			.where(
				and(
					eq(projectChanges.project_id, project.id),
					eq(projectChanges.environment_id, environmentId),
					eq(projects.org_id, actor.orgId),
				),
			)
			.orderBy(asc(projectChanges.created_at));

		return cliJson(cliStagedChangesResponse, {
			environment: environmentName,
			changes: rows.map((r) => ({
				component_type: r.component_type,
				op: r.op,
				component_id: r.component_id,
				created_at: r.created_at.toISOString(),
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
