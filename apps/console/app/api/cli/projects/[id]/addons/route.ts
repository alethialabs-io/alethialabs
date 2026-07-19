// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/addons — the catalog add-ons installed in an environment (defaults to
// the project's default environment; pass ?env= for another). Gated on project `view`; org-scoped
// via an explicit projects.org_id filter (RLS is bypassed here). This is the CLI's "what's
// installed here" view — the console marketplace catalog browsing stays web-only.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import {
	resolveCliEnvironment,
	resolveCliProject,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectAddons, projects } from "@/lib/db/schema";
import { cliAddonsResponse } from "@/lib/validations/cli-contract";

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
			return cliJson(cliAddonsResponse, { environment: environmentName, addons: [] });
		}

		const db = getServiceDb();
		const rows = await db
			.select({
				addon_id: projectAddons.addon_id,
				enabled: projectAddons.enabled,
				mode: projectAddons.mode,
				version: projectAddons.version,
				namespace: projectAddons.namespace,
				status: projectAddons.status,
				health: projectAddons.health,
				sync_status: projectAddons.sync_status,
				last_synced_at: projectAddons.last_synced_at,
			})
			.from(projectAddons)
			.innerJoin(projects, eq(projectAddons.project_id, projects.id))
			.where(
				and(
					eq(projectAddons.project_id, project.id),
					eq(projectAddons.environment_id, environmentId),
					eq(projectAddons.source, "catalog"),
					eq(projects.org_id, actor.orgId),
				),
			);

		return cliJson(cliAddonsResponse, {
			environment: environmentName,
			addons: rows.map((r) => ({
				addon_id: r.addon_id,
				enabled: r.enabled,
				mode: r.mode,
				version: r.version,
				namespace: r.namespace,
				status: r.status,
				health: r.health,
				sync: r.sync_status,
				last_synced_at: r.last_synced_at?.toISOString() ?? null,
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
