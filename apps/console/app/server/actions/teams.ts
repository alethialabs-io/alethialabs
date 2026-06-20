"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, inArray, sql } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { team, teamMember } from "@/lib/db/schema";

export interface TeamRow {
	id: string;
	name: string;
	memberCount: number;
}

/** The active org's teams with their member counts. Community: empty (no teams). */
export async function getTeams(): Promise<TeamRow[]> {
	const actor = await currentActor();
	const db = getServiceDb();
	const teams = await db
		.select({ id: team.id, name: team.name })
		.from(team)
		.where(eq(team.organizationId, actor.orgId));
	if (teams.length === 0) return [];

	const counts = await db
		.select({ teamId: teamMember.teamId, count: sql<number>`count(*)::int` })
		.from(teamMember)
		.where(inArray(teamMember.teamId, teams.map((t) => t.id)))
		.groupBy(teamMember.teamId);
	const byTeam = new Map(counts.map((c) => [c.teamId, c.count]));

	return teams.map((t) => ({ ...t, memberCount: byTeam.get(t.id) ?? 0 }));
}
