// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";

// Always evaluated at request time — never cached.
export const dynamic = "force-dynamic";

/**
 * Public health probe for the status page (Gatus) and load balancers. Returns
 * 200 `{status:"ok"}` after a fast `select 1` DB round-trip, or 503 if the
 * database is unreachable. No auth, no data — just liveness + DB connectivity.
 */
export async function GET(): Promise<Response> {
	try {
		await getServiceDb().execute(sql`select 1`);
		return Response.json({ status: "ok" });
	} catch {
		return Response.json({ status: "error" }, { status: 503 });
	}
}
