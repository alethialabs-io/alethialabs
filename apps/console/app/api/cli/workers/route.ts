// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";

/** Lists workers owned by the CLI user (plus cloud-hosted workers visible to all). */
export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	try {
		const db = getServiceDb();
		const workers = await db
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
			.where(or(eq(runners.user_id, userId), eq(runners.mode, "cloud-hosted")))
			.orderBy(desc(runners.is_default), desc(runners.created_at));

		return NextResponse.json({ workers });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
