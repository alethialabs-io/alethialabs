// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { team } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

/** Deletes a team from organization `id` (team_member rows cascade). */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string; teamId: string }> },
) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id, teamId } = await params;

	const denied = await ensureCliOrgAccess(actor, actor.userId, id);
	if (denied) return denied;

	try {
		const db = getServiceDb();
		const [t] = await db
			.select({ id: team.id })
			.from(team)
			.where(and(eq(team.id, teamId), eq(team.organizationId, id)))
			.limit(1);
		if (!t) {
			return NextResponse.json({ error: "Team not found" }, { status: 404 });
		}

		await db.delete(team).where(eq(team.id, teamId));

		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
