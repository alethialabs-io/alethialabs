"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, inArray } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { team, teamMember, user } from "@/lib/db/schema";

/** A team member, light — for the avatar stack on the Teams cards. */
export interface TeamMemberLite {
	userId: string;
	name: string;
	/** 2-letter avatar initials. */
	initials: string;
}

export interface TeamRow {
	id: string;
	name: string;
	memberCount: number;
	/** The team's members (for the avatar stack + distinct grouped count). */
	members: TeamMemberLite[];
}

/** The active org's teams with their members. Community: empty (no teams). */
export async function getTeams(): Promise<TeamRow[]> {
	const actor = await currentActor();
	const db = getServiceDb();
	const teams = await db
		.select({ id: team.id, name: team.name })
		.from(team)
		.where(eq(team.organizationId, actor.orgId));
	if (teams.length === 0) return [];

	const memberRows = await db
		.select({
			teamId: teamMember.teamId,
			userId: user.id,
			name: user.name,
			email: user.email,
		})
		.from(teamMember)
		.innerJoin(user, eq(teamMember.userId, user.id))
		.where(
			inArray(
				teamMember.teamId,
				teams.map((t) => t.id),
			),
		);

	const byTeam = new Map<string, TeamMemberLite[]>();
	for (const r of memberRows) {
		const display = r.name?.trim() || r.email;
		const list = byTeam.get(r.teamId) ?? [];
		list.push({
			userId: r.userId,
			name: display,
			initials: display.slice(0, 2).toUpperCase(),
		});
		byTeam.set(r.teamId, list);
	}

	return teams.map((t) => {
		const members = byTeam.get(t.id) ?? [];
		return { id: t.id, name: t.name, memberCount: members.length, members };
	});
}
