// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";

/**
 * The database's current timestamp — the one clock a scheduler may compare DB-stamped columns
 * against.
 *
 * Every `jobs` row is stamped by the database (`created_at` is `defaultNow()`), and that column is
 * read back against the database's own `now()` elsewhere: the org 24h quota range-scans it, the
 * retention GC range-scans it, and the claim queue orders by it. So the application must not write
 * it. A sweeper that reads those timestamps back and asks "is this older than the cadence?" has to
 * ask the same clock, not its own replica's — otherwise the arithmetic spans two clocks that are
 * free to drift apart, and the answer is wrong by however far they have drifted.
 */
export async function dbNow(db: Db): Promise<Date> {
	const rows = await db.execute<{ now: Date }>(sql`select now() as now`);
	const now = rows[0]?.now;
	if (!(now instanceof Date)) {
		throw new Error("dbNow: the database did not return a timestamp");
	}
	return now;
}
