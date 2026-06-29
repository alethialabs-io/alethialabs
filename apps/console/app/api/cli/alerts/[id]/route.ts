// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { alertRules } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

/** Deletes an alert rule (its channel bindings cascade). Scoped to the caller's org. */
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
			.delete(alertRules)
			.where(and(eq(alertRules.id, id), eq(alertRules.org_id, actor.orgId)))
			.returning({ id: alertRules.id });
		if (deleted.length === 0) {
			return NextResponse.json({ error: "Alert rule not found" }, { status: 404 });
		}
		invalidateOrgRules(actor.orgId);
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
