"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { member, user } from "@/lib/db/schema";

export interface MemberRow {
	/** member-row id (or the user id when synthesizing the personal owner). */
	id: string;
	userId: string;
	name: string | null;
	email: string;
	image: string | null;
	role: string;
	joinedAt: string;
}

/**
 * Members of the active organization (member ⋈ user). In the community build the
 * active org is the user's personal org, which has no `member` rows — so we
 * synthesize the single owner (you), making the page truthful rather than locked.
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

	if (rows.length > 0) {
		return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
	}

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
		},
	];
}
