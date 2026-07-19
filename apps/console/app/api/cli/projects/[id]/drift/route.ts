// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/drift — the latest day-2 drift posture of a project (optionally
// scoped to one environment). Gated on project `view`; org-scoped via the service DB with an
// explicit projects.org_id filter (RLS is bypassed on this path — the predicate IS the tenancy
// wall). Mirrors getLatestDriftPosture (web), which can't be called here because it authorizes
// via the session cookie.

import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliEnvironment, resolveCliProject } from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { environmentDrift, projects } from "@/lib/db/schema";
import { cliDriftResponse } from "@/lib/validations/cli-contract";

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

		let environmentId: string | null = null;
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
		}

		const db = getServiceDb();
		const rows = await db
			.select({
				in_sync: environmentDrift.in_sync,
				drifted: environmentDrift.drifted,
				details: environmentDrift.details,
				scanned_at: environmentDrift.scanned_at,
			})
			.from(environmentDrift)
			.innerJoin(projects, eq(environmentDrift.project_id, projects.id))
			.where(
				and(
					eq(environmentDrift.project_id, project.id),
					eq(projects.org_id, actor.orgId),
					...(environmentId
						? [eq(environmentDrift.environment_id, environmentId)]
						: []),
				),
			)
			.orderBy(desc(environmentDrift.scanned_at))
			.limit(1);

		const r = rows[0];
		if (!r) {
			// No DETECT_DRIFT job has run yet — honest "not proven", not a false in-sync.
			return cliJson(cliDriftResponse, {
				evaluated: false,
				in_sync: false,
				drifted: 0,
				scanned_at: null,
				environment: environmentName,
				details: [],
			});
		}

		return cliJson(cliDriftResponse, {
			evaluated: true,
			in_sync: r.in_sync,
			drifted: r.drifted,
			scanned_at: r.scanned_at.toISOString(),
			environment: environmentName,
			details: (r.details ?? []).map((d) => ({
				address: d.address,
				type: d.type,
				kind: d.kind,
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
