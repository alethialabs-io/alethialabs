// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { revokeMemberGrant } from "@/lib/authz/grants";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

/** Removes a member from organization `id`, revoking their PDP grants. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string; memberId: string }> },
) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id, memberId } = await params;

	const denied = await ensureCliOrgAccess(actor, actor.userId, id);
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
		if (m.role === "owner") {
			return NextResponse.json(
				{ error: "The owner can't be removed." },
				{ status: 400 },
			);
		}

		await db.delete(member).where(eq(member.id, memberId));
		await revokeMemberGrant(id, m.userId);

		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
