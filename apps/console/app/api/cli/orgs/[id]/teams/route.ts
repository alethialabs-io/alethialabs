// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { count, eq } from "drizzle-orm";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { team, teamMember } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliTeamResponse,
	cliTeamsResponse,
} from "@/lib/validations/cli-contract";
import { teamPlanRefusal, teamRoleRefusal } from "./team-access";
import { createTeamBody } from "@/lib/validations/cli-request-bodies";

/** Lists organization `id`'s teams, each with its team_member count. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor, credential } = auth;
	const { id } = await params;

	const denied = await ensureCliOrgAccess(actor, credential, id, "view", { type: "member" });
	if (denied) return denied;

	try {
		const rows = await getServiceDb()
			.select({
				id: team.id,
				name: team.name,
				member_count: count(teamMember.id),
			})
			.from(team)
			.leftJoin(teamMember, eq(teamMember.teamId, team.id))
			.where(eq(team.organizationId, id))
			.groupBy(team.id, team.name);

		return cliJson(cliTeamsResponse, { teams: rows });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/**
 * Creates a team in organization `id`. Beyond the route's PDP check it asks what the console's
 * team endpoint asks, in the same order: the caller's membership role must hold `team:create`
 * (owners and admins), then the organization must hold the teams entitlement, read through the
 * licence-aware resolver.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor, credential } = auth;
	const { id } = await params;

	const denied = await ensureCliOrgAccess(actor, credential, id, "manage_members", {
		type: "member",
	});
	if (denied) return denied;

	const parsed = createTeamBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}

	try {
		const roleRefusal = await teamRoleRefusal(actor.userId, id, "create");
		if (roleRefusal) return roleRefusal;
		const planRefusal = await teamPlanRefusal(id);
		if (planRefusal) return planRefusal;

		const [row] = await getServiceDb()
			.insert(team)
			.values({ name: parsed.data.name, organizationId: id })
			.returning({ id: team.id, name: team.name });

		return cliJson(
			cliTeamResponse,
			{ team: { id: row.id, name: row.name, member_count: 0 } },
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
