// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared buckets behind lib/rate-limit.ts (#5309). One row per (key, fixed window): the limiter
// counts a hit with ONE `INSERT … ON CONFLICT DO UPDATE … WHERE hits < limit RETURNING`, so the
// check and the increment are a single atomic statement on a single row, and every replica of the
// console counts against the same budget. Before this table the buckets lived in process memory, so
// every limit was multiplied by the replica count and reset on each deploy.
//
// NOT Better Auth's `rate_limit` (schema/auth.ts) — that one belongs to the auth library, keyed and
// shaped the way its adapter wants. This one is ours.
//
// LOGGED, deliberately, though UNLOGGED was considered: at this volume (a handful of rows per active
// person or IP, a few writes a second at most) the WAL saved is negligible, while an unlogged table is
// truncated by crash recovery and is EMPTY on a promoted standby — a failover would hand every caller a
// fresh budget, which is the reset this table exists to remove. It would also need DDL outside the
// drizzle snapshot (drizzle-kit cannot express UNLOGGED), so the snapshot would describe a table the
// database does not have.
//
// Service role only: the limiter is called before (or without) any actor scope. No RLS — the rows
// carry a bucket key and a counter, and the key names a user id or a client IP the caller already has.
//
// EXPIRY. `expires_at` is the end of the row's window; the reconcile loop's `rate-limit-sweep` deletes
// rows past it (lib/rate-limit.ts · sweepExpiredRateLimitBuckets). A row the sweep has not reached yet
// is harmless: a hit in a later window lands in a different (key, window_start) row.

import {
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const rateLimitBuckets = pgTable(
	"rate_limit_buckets",
	{
		// The caller's bucket name, e.g. `kubeconfig-mint:<org>:<user>`. Unique per policy.
		key: text().notNull(),
		// Start of the fixed window this row counts, aligned to the policy's window length.
		window_start: timestamp({ withTimezone: true }).notNull(),
		// Hits ALLOWED in this window. Never exceeds the policy's limit: a refused hit is not counted.
		hits: integer().notNull(),
		// `window_start` + the window length — the sweep's key.
		expires_at: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.key, t.window_start] }),
		index("idx_rate_limit_buckets_expires").on(t.expires_at),
	],
);
