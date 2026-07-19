// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/byo-iac — the customer's BYO Terraform/OpenTofu source attached to an
// environment (or null when none). Gated on project `view`; org-scoped via an explicit
// projects.org_id filter (RLS bypassed here). Mirrors getIacSource (web) but omits the full scan
// report — status only.

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
import { projectIacSources, projects } from "@/lib/db/schema";
import { cliIacSourceResponse } from "@/lib/validations/cli-contract";

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
		if (!environmentId) return cliJson(cliIacSourceResponse, { source: null });

		const db = getServiceDb();
		const [row] = await db
			.select({
				id: projectIacSources.id,
				name: projectIacSources.name,
				repo_url: projectIacSources.repo_url,
				ref: projectIacSources.ref,
				path: projectIacSources.path,
				commit_sha: projectIacSources.commit_sha,
				deployed_commit_sha: projectIacSources.deployed_commit_sha,
				enabled: projectIacSources.enabled,
				scan_status: projectIacSources.scan_status,
				scanned_at: projectIacSources.scanned_at,
				status: projectIacSources.status,
				status_message: projectIacSources.status_message,
			})
			.from(projectIacSources)
			.innerJoin(projects, eq(projectIacSources.project_id, projects.id))
			.where(
				and(
					eq(projectIacSources.project_id, project.id),
					eq(projectIacSources.environment_id, environmentId),
					eq(projects.org_id, actor.orgId),
				),
			)
			.limit(1);

		if (!row) return cliJson(cliIacSourceResponse, { source: null });

		return cliJson(cliIacSourceResponse, {
			source: {
				id: row.id,
				environment: environmentName,
				name: row.name,
				repo_url: row.repo_url,
				ref: row.ref,
				path: row.path,
				commit_sha: row.commit_sha,
				deployed_commit_sha: row.deployed_commit_sha,
				enabled: row.enabled,
				scan_status: row.scan_status,
				scanned_at: row.scanned_at?.toISOString() ?? null,
				status: row.status,
				status_message: row.status_message,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
