// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { authorizeCli } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import { recordActivity } from "@/lib/authz/activity";
import { getServiceDb } from "@/lib/db";
import { role } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOkResponse } from "@/lib/validations/cli-contract";

/** Deletes a custom role (mirrors the deleteRole action). Built-in roles cannot be
 * deleted — the is_builtin=false filter makes that a no-op. Grants on the role
 * cascade-delete (FK). Gated on `manage_members` of `member` + customRoles. */
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
			{ error: "Custom roles require an Enterprise license." },
			{ status: 402 },
		);
	}

	try {
		await getServiceDb()
			.delete(role)
			.where(
				and(
					eq(role.id, id),
					eq(role.organization_id, actor.orgId),
					eq(role.is_builtin, false),
				),
			);

		emitAlertEventSafe(actor.orgId, "authz.role.delete", {
			title: "Role deleted",
			severity: "warning",
			actor_id: actor.userId,
			action: "delete",
			resource_type: "role",
			resource_id: id,
		});
		recordActivity(actor, "destroy", { type: "role", id });

		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
