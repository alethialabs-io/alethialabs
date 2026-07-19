// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/probes — each environment's latest cluster-alive probe (the "is it
// still up?" day-2 signal). Gated on project `view`; org-scoped via getLatestProbesByEnv's own
// explicit org filter plus the resolveCliProject org lookup. Reuses the same read the console
// reconcile badges use.

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getLatestProbesByEnv } from "@/app/server/actions/probes";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments } from "@/lib/db/schema";
import { cliProbesResponse } from "@/lib/validations/cli-contract";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		const db = getServiceDb();
		const envs = await db
			.select({ id: projectEnvironments.id, name: projectEnvironments.name })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, project.id));

		const probeMap = await getLatestProbesByEnv(project.id, actor.orgId);

		return cliJson(cliProbesResponse, {
			probes: envs.map((e) => {
				const p = probeMap.get(e.id);
				return {
					environment_id: e.id,
					environment: e.name,
					reachable: p ? p.reachable : null,
					message: p ? p.message : null,
					probed_at: p ? p.probedAt : null,
				};
			}),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
