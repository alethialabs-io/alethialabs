// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { revokeMemberGrant } from "@/lib/authz/grants";
import { cancelPendingInvitationsFrom, deleteOrgTeamMemberships } from "@/lib/authz/member-exit";
import { toPdpRole } from "@/lib/authz/org-access-control";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

/**
 * Removes a member from organization `id`, revoking their PDP grants. Their `team_member` rows in
 * the org's teams go with the member row, as in better-auth's `deleteMember`, and the invitations
 * they sent that are still pending are cancelled (#5484).
 *
 * An owner is never removed here. "Owner" is read the way the PDP reads it (`toPdpRole`), so
 * `owner,admin` is one (#5472): the old `role === "owner"` let such a member be removed, and with
 * them the org's last owner.
 */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string; memberId: string }> },
) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor, credential } = auth;
	const { id, memberId } = await params;

	const denied = await ensureCliOrgAccess(actor, credential, id, "manage_members", {
		type: "member",
	});
	if (denied) return denied;

	try {
		const db = getServiceDb();
		const [m] = await db
			.select({ userId: member.userId, role: member.role })
			.from(member)
			.where(and(eq(member.id, memberId), eq(member.organizationId, id)))
			.limit(1);
		if (!m) {
			return NextResponse.json({ error: "Member not found" }, { status: 404 });
		}
		if (toPdpRole(m.role) === "owner") {
			return NextResponse.json(
				{ error: "The owner can't be removed." },
				{ status: 400 },
			);
		}

		await db.transaction(async (tx) => {
			await tx.delete(member).where(eq(member.id, memberId));
			await deleteOrgTeamMemberships(tx, id, m.userId);
			await cancelPendingInvitationsFrom(tx, id, m.userId);
		});
		await revokeMemberGrant(id, m.userId);

		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
