// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/protection — each environment's promotion protection rules
// (predecessor / verify-pass / approval / soak / cost gates). Gated on project `view`;
// org-scoped via an explicit projects.org_id filter (RLS is bypassed here — the predicate is
// the tenancy wall). Mirrors listProtectionRules (web).

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import {
	environmentProtectionRules,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { cliProtectionResponse } from "@/lib/validations/cli-contract";

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
		const rows = await db
			.select({
				environment_id: environmentProtectionRules.environment_id,
				environment: projectEnvironments.name,
				require_predecessor: environmentProtectionRules.require_predecessor,
				require_verify_pass: environmentProtectionRules.require_verify_pass,
				require_approval: environmentProtectionRules.require_approval,
				approvers: environmentProtectionRules.approvers,
				soak_minutes: environmentProtectionRules.soak_minutes,
				cost_delta_threshold: environmentProtectionRules.cost_delta_threshold,
			})
			.from(environmentProtectionRules)
			.innerJoin(projects, eq(environmentProtectionRules.project_id, projects.id))
			.innerJoin(
				projectEnvironments,
				eq(environmentProtectionRules.environment_id, projectEnvironments.id),
			)
			.where(
				and(
					eq(environmentProtectionRules.project_id, project.id),
					eq(projects.org_id, actor.orgId),
				),
			);

		return cliJson(cliProtectionResponse, {
			rules: rows.map((r) => ({
				environment_id: r.environment_id,
				environment: r.environment,
				require_predecessor: r.require_predecessor,
				require_verify_pass: r.require_verify_pass,
				require_approval: r.require_approval,
				min_count: r.approvers?.min_count ?? null,
				soak_minutes: r.soak_minutes,
				cost_delta_threshold: r.cost_delta_threshold,
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
