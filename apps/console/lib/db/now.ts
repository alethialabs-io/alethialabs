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
 *
 * Asked for as epoch seconds rather than as a `timestamptz`, and read positionally, so the value
 * crosses the driver boundary as a plain number under whatever shape `execute` returns. `select
 * now()` was tried first and came back as something that failed an `instanceof Date` check — and
 * that check is unreliable regardless, because a test framework faking time replaces the global
 * `Date`, so a driver-built date is no longer an instance of it. The explicit `::double precision`
 * also pins the return type across the PG14 change where `extract()` began yielding `numeric`.
 */
export async function dbNow(db: Db): Promise<Date> {
	const rows = await db.execute<Record<string, unknown>>(
		sql`select extract(epoch from now())::double precision as epoch_s`,
	);
	const row = rows[0];
	const epochSeconds = row === undefined ? Number.NaN : Number(Object.values(row)[0]);
	if (!Number.isFinite(epochSeconds)) {
		throw new Error("dbNow: the database did not return a usable timestamp");
	}
	return new Date(epochSeconds * 1000);
}
