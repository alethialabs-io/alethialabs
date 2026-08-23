"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isEnumMember } from "@/lib/coerce";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { currentActor } from "@/lib/authz/guard";
import { markFailed, markHealthy } from "@/lib/connectors/health";
import { auth } from "@/lib/auth";
import { resolveAccountId } from "@/lib/auth/accounts";
import { getOwner } from "@/lib/auth/owner";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";

// Git provider tokens live in Better Auth's `account` table (Phase D full
// consolidation). Better Auth captures them on link and refreshes them on
// demand via getAccessToken — no dedicated provider_tokens table or manual
// refresh map anymore.

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

function isGitProvider(p: string): p is PublicGitProvider {
	return isEnumMember(p, GIT_PROVIDERS);
}

/** Git providers the current user has linked (from Better Auth accounts). */
export async function getLinkedProviders(): Promise<PublicGitProvider[]> {
	try {
		const accounts = await auth.api.listUserAccounts({ headers: await headers() });
		const set = new Set<PublicGitProvider>();
		for (const a of accounts) {
			if (isGitProvider(a.providerId)) set.add(a.providerId);
		}
		return Array.from(set);
	} catch (error) {
		console.error("Unexpected error fetching linked providers:", error);
		return [];
	}
}

/**
 * A valid (auto-refreshed) access token for the current user's linked provider,
 * or null. Better Auth handles refresh transparently via getAccessToken.
 */
export async function getValidProviderToken(
	provider: PublicGitProvider,
): Promise<string | null> {
	let scope: { userId: string; orgId: string };
	try {
		const actor = await currentActor();
		scope = { userId: actor.userId, orgId: actor.orgId };
	} catch {
		return null;
	}
	try {
		// 1.7 selectors take the LOCAL account.id, not the provider id. No link → no token,
		// and that is an expected state (the user simply has not connected this provider),
		// so report it the same way a missing token is reported rather than throwing.
		const accountId = await resolveAccountId(scope.userId, provider);
		if (accountId === null) {
			void markFailed(scope, "git", provider, "no linked account for this provider");
			return null;
		}
		const res = await auth.api.getAccessToken({
			body: { accountId, userId: scope.userId },
			headers: await headers(),
		});
		const token = res.accessToken ?? null;
		// Point-of-use connector health: success clears, failure emits once (durable, no poll).
		if (token) void markHealthy(scope, "git", provider);
		else void markFailed(scope, "git", provider, "no access token returned");
		return token;
	} catch (err) {
		void markFailed(
			scope,
			"git",
			provider,
			err instanceof Error ? err.message : "token refresh failed",
		);
		return null;
	}
}

/** Unlinks a git provider from the current user. */
export async function deleteProviderToken(provider: PublicGitProvider) {
	try {
		// 1.7's unlinkAccount takes the local account.id. Resolving it needs the user, which
		// the session carries — but currentActor() is the seam that already knows it.
		const actor = await currentActor();
		const accountId = await resolveAccountId(actor.userId, provider);
		if (accountId === null) {
			// Already unlinked. Idempotent: the caller's intent is satisfied.
			revalidatePath("/dashboard/connectors");
			return { success: true };
		}
		await auth.api.unlinkAccount({
			body: { accountId },
			headers: await headers(),
		});
		revalidatePath("/dashboard/connectors");
		return { success: true };
	} catch (error) {
		console.error("Unexpected error unlinking provider:", error);
		return { error: "Unexpected error occurred" };
	}
}
