// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, user } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliActivityResponse } from "@/lib/validations/cli-contract";

/** Default + maximum page sizes for the activity log. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Reads the active org's delivery/activity log (the PDP-written
 * authz_activity_log joined to the acting user), newest first. `?limit=` caps the
 * page size. Scoped by org_id, gated on `view_activity`. */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view_activity", { type: "activity" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const url = new URL(req.url);
	const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
		: DEFAULT_LIMIT;

	try {
		const rows = await getServiceDb()
			.select({
				id: authzActivityLog.id,
				actor_id: authzActivityLog.actor_id,
				actor_name: user.name,
				actor_email: user.email,
				action: authzActivityLog.action,
				resource_type: authzActivityLog.resource_type,
				resource_id: authzActivityLog.resource_id,
				decision: authzActivityLog.decision,
				reason: authzActivityLog.reason,
				ts: authzActivityLog.ts,
			})
			.from(authzActivityLog)
			.leftJoin(user, eq(authzActivityLog.actor_id, user.id))
			.where(eq(authzActivityLog.org_id, actor.orgId))
			.orderBy(desc(authzActivityLog.id))
			.limit(limit);

		const activity = rows.map((r) => ({
			id: String(r.id),
			actor_id: r.actor_id,
			actor_name: r.actor_name ?? null,
			actor_email: r.actor_email ?? null,
			action: r.action,
			resource_type: r.resource_type,
			resource_id: r.resource_id ?? null,
			decision: r.decision,
			reason: r.reason ?? null,
			ts: r.ts.toISOString(),
		}));

		return cliJson(cliActivityResponse, { activity });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
