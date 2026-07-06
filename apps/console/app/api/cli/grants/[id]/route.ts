// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { authorizeCli } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import { recordActivity } from "@/lib/authz/activity";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import { grants } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

/** Revokes an access grant (mirrors the revokeGrant action) and removes its PDP
 * tuples. Gated on `manage_members` of `member` + customRoles. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "manage_members", { type: "member" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	if (!getEntitlements(actor).customRoles) {
		return NextResponse.json(
			{ error: "Access management requires an Enterprise license." },
			{ status: 402 },
		);
	}

	try {
		const db = getServiceDb();
		const [g] = await db
			.select()
			.from(grants)
			.where(and(eq(grants.id, id), eq(grants.org_id, actor.orgId)))
			.limit(1);
		if (!g) return cliJson(cliOkResponse, { ok: true });

		await db
			.delete(grants)
			.where(and(eq(grants.id, id), eq(grants.org_id, actor.orgId)));

		void getTupleSync()
			.removeScopedGrant({
				orgId: g.org_id,
				principalType: g.principal_type === "team" ? "team" : "user",
				principalId: g.principal_id,
				effect: g.effect === "deny" ? "deny" : "allow",
				resourceType: g.resource_type,
				resourceId: g.resource_id,
				roleId: g.role_id,
				permissionKey: g.permission_key,
			})
			.catch((err) => console.error("[authz] grant tuple removal failed:", err));

		emitAlertEventSafe(actor.orgId, "authz.grant.revoke", {
			title: `Grant revoked: ${g.effect} ${g.permission_key ?? "role"} on ${g.resource_type}`,
			severity: "warning",
			actor_id: actor.userId,
			action: "revoke",
			resource_type: g.resource_type,
			resource_id: g.resource_id ?? undefined,
		});
		recordActivity(actor, "revoke", { type: "grant", id });

		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
