// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { z } from "zod";
import { actorHoldsAllKeys } from "@/lib/authz/ceiling";
import { authorizeCli, authorizeCliOrg, ensureCliOrgAccess } from "@/lib/authz/guard";
import { type OrgRole, toPdpRole } from "@/lib/authz/org-access-control";
import { BUILT_IN_ROLES, PERMISSIONS, type PermissionKey } from "@/lib/authz/registry";
import { INVITE_ROLES } from "@/lib/members/roles";
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

/**
 * The role an invite may carry, or null (#5479). One role name — a comma-joined list is refused —
 * that resolves (`member` is Better Auth's alias for `viewer`) to one of the roles the console's
 * invite dialog offers. `owner` is not among them: an owner is the org's creator, never invited.
 */
function invitableRole(value: string): OrgRole | null {
	const name = value.trim();
	if (name.includes(",")) return null;
	const role = toPdpRole(name);
	return role && INVITE_ROLES.some((r) => r.value === role) ? role : null;
}

/** The permission keys a built-in role confers; `"*"` is every key in the registry. */
function roleKeys(role: OrgRole): readonly PermissionKey[] {
	const keys = BUILT_IN_ROLES[role];
	return keys === "*" ? PERMISSIONS.map((p) => p.key) : keys;
}

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
	const { actor, credential } = auth;
	const { id } = await params;

	const denied = await ensureCliOrgAccess(actor, credential, id, "view", { type: "member" });
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
	const { actor, credential } = auth;
	const { id } = await params;

	const access = await authorizeCliOrg(actor, credential, id, "manage_members", {
		type: "member",
	});
	if ("error" in access) return access.error;

	const parsed = inviteBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
	}
	const { email } = parsed.data;
	const role = invitableRole(parsed.data.role);
	if (!role) {
		return NextResponse.json(
			{ error: `role must be one of: ${INVITE_ROLES.map((r) => r.value).join(", ")}` },
			{ status: 400 },
		);
	}
	// The privilege ceiling, asked of the inviter IN THE PATH ORG: an invite may not confer a
	// permission the inviter does not hold there. This row is written directly, so better-auth's
	// own invite checks never see it.
	if (!(await actorHoldsAllKeys(access.actor, roleKeys(role)))) {
		return NextResponse.json(
			{ error: "You can't invite someone to a role with more access than your own." },
			{ status: 403 },
		);
	}

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
