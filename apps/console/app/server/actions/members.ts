"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, inArray, sql } from "drizzle-orm";
import { ensureMemberGrant, revokeMemberGrant } from "@/lib/authz/grants";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import {
	invitation,
	member,
	session,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";

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
	/** 'active' | 'suspended'. */
	status: string;
	/** ISO timestamp of the member's most recent session, or null if never. */
	lastActiveAt: string | null;
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
			status: member.status,
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
				status: "active",
				joinedAt: u.createdAt.toISOString(),
				teams: [],
				lastActiveAt: new Date().toISOString(),
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

	// Last-active = the most recent session per user.
	const lastRows = await db
		.select({
			userId: session.userId,
			last: sql<string>`max(${session.updatedAt})`,
		})
		.from(session)
		.where(inArray(session.userId, userIds))
		.groupBy(session.userId);
	const lastByUser = new Map<string, string>();
	for (const r of lastRows) {
		if (r.last) lastByUser.set(r.userId, new Date(r.last).toISOString());
	}

	return rows.map((r) => ({
		...r,
		joinedAt: r.joinedAt.toISOString(),
		teams: teamsByUser.get(r.userId) ?? [],
		lastActiveAt: lastByUser.get(r.userId) ?? null,
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

/**
 * Suspends or reactivates a member. Suspending keeps the member row + role but revokes
 * their PDP grant (no access); reactivating restores the grant. Owner-gated; refuses on
 * the org owner and on members from a different org.
 */
export async function setMemberSuspended(
	memberId: string,
	suspended: boolean,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_members", { type: "member" });
	const db = getServiceDb();

	const [m] = await db
		.select({
			orgId: member.organizationId,
			userId: member.userId,
			role: member.role,
		})
		.from(member)
		.where(eq(member.id, memberId))
		.limit(1);
	if (!m || m.orgId !== actor.orgId) throw new Error("Member not found.");
	if (m.role === "owner") throw new Error("The owner can't be suspended.");

	await db
		.update(member)
		.set({ status: suspended ? "suspended" : "active" })
		.where(eq(member.id, memberId));

	if (suspended) {
		await revokeMemberGrant(m.orgId, m.userId);
	} else {
		await ensureMemberGrant(m.orgId, m.userId, m.role);
	}
	return { ok: true };
}
