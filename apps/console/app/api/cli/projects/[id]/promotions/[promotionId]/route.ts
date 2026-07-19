// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/promotions/:promotionId — one promotion with its approval slots.
// Gated on project `view`; the promotion is loaded scoped to the resolved project + org (the
// tenancy wall). Mirrors getPromotionDetail (web) but omits the per-gate evaluation + config diff
// (console-only) — the CLI shows status, the approval tally, and the approval slots.

import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import {
	environmentPromotions,
	projectEnvironments,
	projects,
	promotionApprovals,
	user,
} from "@/lib/db/schema";
import { cliPromotionResponse } from "@/lib/validations/cli-contract";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; promotionId: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id, promotionId } = await params;

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		const db = getServiceDb();
		// Load the promotion scoped to this project + org — the tenancy wall.
		const [promotion] = await db
			.select()
			.from(environmentPromotions)
			.innerJoin(projects, eq(environmentPromotions.project_id, projects.id))
			.where(
				and(
					eq(environmentPromotions.id, promotionId),
					eq(environmentPromotions.project_id, project.id),
					eq(projects.org_id, actor.orgId),
				),
			)
			.limit(1);
		if (!promotion) {
			return NextResponse.json({ error: "Promotion not found" }, { status: 404 });
		}
		const p = promotion.environment_promotions;

		const [envs, approvalRows, initiatorRow] = await Promise.all([
			db
				.select({ id: projectEnvironments.id, name: projectEnvironments.name })
				.from(projectEnvironments)
				.where(inArray(projectEnvironments.id, [p.source_environment_id, p.target_environment_id])),
			db
				.select({
					id: promotionApprovals.id,
					status: promotionApprovals.status,
					required_role: promotionApprovals.required_role,
					comment: promotionApprovals.comment,
					decided_at: promotionApprovals.decided_at,
					approver_name: user.name,
				})
				.from(promotionApprovals)
				.leftJoin(user, eq(user.id, promotionApprovals.decided_by))
				.where(eq(promotionApprovals.promotion_id, promotionId)),
			p.user_id
				? db.select({ name: user.name }).from(user).where(eq(user.id, p.user_id)).limit(1)
				: Promise.resolve([]),
		]);
		const nameOf = (envId: string) => envs.find((e) => e.id === envId)?.name ?? "—";
		const approved = approvalRows.filter((a) => a.status === "approved").length;

		return cliJson(cliPromotionResponse, {
			promotion: {
				id: p.id,
				source: nameOf(p.source_environment_id),
				target: nameOf(p.target_environment_id),
				status: p.status,
				initiator: initiatorRow[0]?.name ?? null,
				error_message: p.error_message,
				approved,
				required: approvalRows.length,
				approvals: approvalRows.map((a) => ({
					id: a.id,
					status: a.status,
					name: a.approver_name,
					required_role: a.required_role,
					comment: a.comment,
					decided_at: a.decided_at?.toISOString() ?? null,
				})),
				created_at: p.created_at.toISOString(),
				completed_at: p.completed_at?.toISOString() ?? null,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
