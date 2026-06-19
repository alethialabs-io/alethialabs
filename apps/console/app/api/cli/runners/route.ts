// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Lists runners owned by the CLI user (plus cloud-hosted runners visible to all). */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "runner" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();
		const runnerRows = await db
			.select({
				id: runners.id,
				name: runners.name,
				mode: runners.mode,
				status: runners.status,
				last_heartbeat: runners.last_heartbeat,
				version: runners.version,
				is_default: runners.is_default,
				created_at: runners.created_at,
			})
			.from(runners)
			.where(
				or(eq(runners.org_id, actor.orgId), eq(runners.mode, "cloud-hosted")),
			)
			.orderBy(desc(runners.is_default), desc(runners.created_at));

		return NextResponse.json({ runners: runnerRows });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
