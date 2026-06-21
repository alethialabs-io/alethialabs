"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, inArray } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { invitation, member, team, teamMember, user } from "@/lib/db/schema";

export interface MemberRow {
	/** member-row id (or the user id when synthesizing the personal owner). */
	id: string;
	userId: string;
	name: string | null;
	email: string;
	image: string | null;
	role: string;
	joinedAt: string;
	/** Names of the teams this member belongs to in the active org. */
	teams: string[];
}

/**
 * Members of the active organization (member ⋈ user), each with their team names. In
 * the community build the active org is the user's personal org, which has no `member`
 * rows — so we synthesize the single owner (you), making the page truthful not locked.
 */
export async function getMembers(): Promise<MemberRow[]> {
	const actor = await currentActor();
	const db = getServiceDb();

	const rows = await db
		.select({
			id: member.id,
			userId: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			role: member.role,
			joinedAt: member.createdAt,
		})
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(eq(member.organizationId, actor.orgId));

	if (rows.length === 0) {
		// Personal workspace: you are the sole owner.
		const [u] = await db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
				createdAt: user.createdAt,
			})
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		if (!u) return [];
		return [
			{
				id: u.id,
				userId: u.id,
				name: u.name,
				email: u.email,
				image: u.image,
				role: "owner",
				joinedAt: u.createdAt.toISOString(),
				teams: [],
			},
		];
	}

	// Team names per member (only this org's teams).
	const userIds = rows.map((r) => r.userId);
	const teamRows = await db
		.select({ userId: teamMember.userId, name: team.name })
		.from(teamMember)
		.innerJoin(team, eq(teamMember.teamId, team.id))
		.where(
			and(
				eq(team.organizationId, actor.orgId),
				inArray(teamMember.userId, userIds),
			),
		);
	const teamsByUser = new Map<string, string[]>();
	for (const t of teamRows) {
		const arr = teamsByUser.get(t.userId) ?? [];
		arr.push(t.name);
		teamsByUser.set(t.userId, arr);
	}

	return rows.map((r) => ({
		...r,
		joinedAt: r.joinedAt.toISOString(),
		teams: teamsByUser.get(r.userId) ?? [],
	}));
}

/** A pending invitation to the active org. */
export interface InvitationRow {
	id: string;
	email: string;
	role: string;
	inviterName: string;
	createdAt: string;
}

/** Pending invitations for the active organization (invitation ⋈ inviter). */
export async function getInvitations(): Promise<InvitationRow[]> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return []; // personal scope → no invitations
	const db = getServiceDb();

	const rows = await db
		.select({
			id: invitation.id,
			email: invitation.email,
			role: invitation.role,
			inviterName: user.name,
			inviterEmail: user.email,
			createdAt: invitation.createdAt,
		})
		.from(invitation)
		.leftJoin(user, eq(invitation.inviterId, user.id))
		.where(
			and(
				eq(invitation.organizationId, actor.orgId),
				eq(invitation.status, "pending"),
			),
		);

	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		role: r.role ?? "viewer",
		inviterName: r.inviterName ?? r.inviterEmail ?? "—",
		createdAt: r.createdAt.toISOString(),
	}));
}
