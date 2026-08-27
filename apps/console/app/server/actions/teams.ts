"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, inArray } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { team, teamMember, user } from "@/lib/db/schema";
import {
	queryTeamsPage,
	type TeamsPage,
	type TeamsQuery,
} from "@/lib/queries/teams";

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

/**
 * The Teams PAGE read (#2899): rows filtered SERVER-SIDE in SQL for `query`, plus size-facet
 * counts over the org's UNFILTERED teams — the console filter standard's step 5 + 6
 * (lib/query/README.md). Key it with `qk.teams(org, q)`.
 *
 * The unfiltered `getTeams()` above stays as it is: it is the shared universe read (the
 * manage-team dialog, the grant builder) and its `qk.teams(org)` cache. This mirrors
 * `getJobs()` / `getJobsPage()` — a page's parameterized read is a sibling, not a
 * replacement.
 *
 * Authorization is IDENTICAL to `getTeams()`: `currentActor()` resolves the caller's active
 * tenancy, and every SQL predicate is scoped to `actor.orgId` (never a client-supplied org).
 */
export async function getTeamsPage(query: TeamsQuery = {}): Promise<TeamsPage> {
	const actor = await currentActor();
	return queryTeamsPage(actor.orgId, query);
}
