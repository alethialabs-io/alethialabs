// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { alertChannels } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

/** Deletes a notification channel (its rule bindings cascade; deliveries keep
 * history via SET NULL). Scoped to the caller's org. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "manage_alerts", { type: "alert" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	try {
		const deleted = await getServiceDb()
			.delete(alertChannels)
			.where(and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)))
			.returning({ id: alertChannels.id });
		if (deleted.length === 0) {
			return NextResponse.json({ error: "Channel not found" }, { status: 404 });
		}
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
