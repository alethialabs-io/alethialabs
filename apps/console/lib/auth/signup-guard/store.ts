// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-up guard's two reads and one write against the database, kept apart from the decision
// (./guard.ts) so the decision can be tested without a database and this file stays thin.
//
// NO NEW TABLE. The per-network counter is a row in the console's shared rate-limit bucket table
// (lib/rate-limit.ts, `rate_limit_buckets`); the invitation check reads Better Auth's `invitation`
// table, which exists in every edition.

import { and, eq, gt, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { invitation } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";

/** One UTC day in milliseconds. The bucket table's windows start at multiples of it, i.e. 00:00 UTC. */
export const UTC_DAY_MS = 86_400_000;

/**
 * Counts one new account against `key` for the current UTC day and reports whether it fits under
 * `limit`. A refused hit is not counted. Fails CLOSED: when the bucket store cannot answer, the
 * account is refused — the same database the account would be written to is the one that failed.
 */
export async function countSignupForNetwork(key: string, limit: number): Promise<boolean> {
	const result = await checkRateLimit(key, limit, UTC_DAY_MS, { failOpen: false });
	return result.ok;
}

/**
 * Whether an unexpired, pending organization invitation exists for this address. The address is
 * compared case-insensitively. Invitations are written by an organization's admins, so an invited
 * address is someone a member asked for — it is not counted against the network ceiling.
 */
export async function hasPendingInvitation(email: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: invitation.id })
		.from(invitation)
		.where(
			and(
				eq(sql`lower(${invitation.email})`, email.trim().toLowerCase()),
				eq(invitation.status, "pending"),
				gt(invitation.expiresAt, sql`now()`),
			),
		)
		.limit(1);
	return row !== undefined;
}
