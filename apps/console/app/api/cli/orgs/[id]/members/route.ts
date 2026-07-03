// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { invitation, member, user } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliInvitationResponse,
	cliMembersResponse,
} from "@/lib/validations/cli-contract";

/** Pending-invitation lifetime — 7 days from creation. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Body of POST /api/cli/orgs/:id/members — invite a user by email. */
const inviteBody = z.object({
	email: z.string().email(),
	role: z.string().min(1),
});

/** Lists the members of organization `id` (member ⋈ user). */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const denied = await ensureCliOrgAccess(actor, actor.userId, id);
	if (denied) return denied;

	try {
		const rows = await getServiceDb()
			.select({
				id: member.id,
				user_id: user.id,
				email: user.email,
				name: user.name,
				role: member.role,
				status: member.status,
			})
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(eq(member.organizationId, id));

		const members = rows.map((r) => ({ ...r, name: r.name ?? "" }));
		return cliJson(cliMembersResponse, { members });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Invites a user (by email) to organization `id`, returning the pending invitation. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const denied = await ensureCliOrgAccess(actor, actor.userId, id);
	if (denied) return denied;

	const parsed = inviteBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const { email, role } = parsed.data;

	try {
		const [row] = await getServiceDb()
			.insert(invitation)
			.values({
				organizationId: id,
				email,
				role,
				status: "pending",
				inviterId: actor.userId,
				expiresAt: new Date(Date.now() + INVITE_TTL_MS),
			})
			.returning({
				id: invitation.id,
				email: invitation.email,
				role: invitation.role,
				status: invitation.status,
			});

		return cliJson(
			cliInvitationResponse,
			{
				invitation: { id: row.id, email: row.email, role: row.role ?? role, status: row.status },
			},
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
