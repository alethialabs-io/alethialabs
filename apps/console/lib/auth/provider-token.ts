// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A user's own git provider token, fetched server-side for a call the user asked for (#6549).
//
// It takes the user id rather than reading the request's session, so the console action and the CLI
// route call ONE function: a CLI request carries an API token, not a Better Auth session, and
// `getValidProviderToken` (app/server/actions/identities.ts) passes the request headers, which makes
// Better Auth refuse a session-less call before it reads `userId` (the git-token route records the
// same trap). The caller must already have authenticated the user and authorised the action; this
// function only reads that user's own linked account.

import "server-only";
import { auth } from "@/lib/auth";
import { resolveAccountId } from "@/lib/auth/accounts";

/** The user's access token for `provider`, refreshed when needed, or null when they have no usable link. */
export async function providerTokenForUser(
	userId: string,
	provider: "github" | "gitlab" | "bitbucket",
): Promise<string | null> {
	const accountId = await resolveAccountId(userId, provider);
	if (accountId === null) return null;
	try {
		// No `headers`: see the file comment.
		const res = await auth.api.getAccessToken({ body: { accountId, userId } });
		return res.accessToken ?? null;
	} catch {
		// A link whose token cannot be refreshed is, for the caller, no link. The reason is not
		// logged here: the error may carry provider text, and the caller says "reconnect".
		return null;
	}
}
