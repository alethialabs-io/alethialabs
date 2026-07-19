// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/byo-charts — the customer's own Helm charts (source='byo') attached to
// an environment. Gated on project `view`; org-scoped via an explicit projects.org_id filter (RLS
// bypassed here). Mirrors getProjectByoCharts (web) but omits the full scan report — status only.

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
import { cliByoChartsResponse } from "@/lib/validations/cli-contract";

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
			return cliJson(cliByoChartsResponse, { environment: environmentName, charts: [] });
		}

		const db = getServiceDb();
		const rows = await db
			.select({
				addon_id: projectAddons.addon_id,
				chart_repo: projectAddons.chart_repo,
				chart_path: projectAddons.chart_path,
				version: projectAddons.version,
				namespace: projectAddons.namespace,
				status: projectAddons.status,
				health: projectAddons.health,
				sync_status: projectAddons.sync_status,
				scan_status: projectAddons.scan_status,
				scanned_at: projectAddons.scanned_at,
			})
			.from(projectAddons)
			.innerJoin(projects, eq(projectAddons.project_id, projects.id))
			.where(
				and(
					eq(projectAddons.project_id, project.id),
					eq(projectAddons.environment_id, environmentId),
					eq(projectAddons.source, "byo"),
					eq(projects.org_id, actor.orgId),
				),
			);

		return cliJson(cliByoChartsResponse, {
			environment: environmentName,
			charts: rows.map((r) => ({
				id: r.addon_id,
				repo_url: r.chart_repo ?? "",
				chart_path: r.chart_path ?? "",
				ref: r.version ?? "HEAD",
				namespace: r.namespace ?? "default",
				status: r.status,
				health: r.health,
				sync: r.sync_status,
				scan_status: r.scan_status,
				scanned_at: r.scanned_at?.toISOString() ?? null,
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
