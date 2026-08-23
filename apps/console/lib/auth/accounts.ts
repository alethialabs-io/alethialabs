// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { account } from "@/lib/db/schema";
import { getServiceDb } from "@/lib/db";

/**
 * Resolves a user's linked account for one provider to the LOCAL `account.id` that Better Auth 1.7's
 * account selectors take, or null when the user has no such link.
 *
 * This exists because 1.7 changed what `accountId` MEANS while keeping the name. In 1.6,
 * `auth.api.getAccessToken({ body: { providerId, userId } })` matched on the provider-side
 * identifier. In 1.7 the selector is `{ accountId: account.id, userId? }` — the row's primary key —
 * and `providerId` is rejected outright by a `z.strictObject`. A call that keeps passing the
 * provider-side value does not fail loudly at the boundary; it simply matches nothing and throws
 * ACCOUNT_NOT_FOUND, which for the git-token path is indistinguishable from "the user never linked
 * their account".
 *
 * It reads the table directly rather than going through `auth.api.listUserAccounts`, because that
 * endpoint is session-authenticated and the most important caller has no session: the runner's
 * git-token route is a server-to-server call that names a `userId`. One code path for all four
 * callers is also one thing to test.
 *
 * @param userId the owning user
 * @param providerId the Better Auth provider id ("github", "gitlab", "bitbucket", "google")
 * @returns the local `account.id`, or null when the user has no link for that provider
 */
export async function resolveAccountId(
	userId: string,
	providerId: string,
): Promise<string | null> {
	const db = getServiceDb();
	const rows = await db
		.select({ id: account.id })
		.from(account)
		.where(and(eq(account.userId, userId), eq(account.providerId, providerId)))
		.limit(1);
	return rows[0]?.id ?? null;
}
