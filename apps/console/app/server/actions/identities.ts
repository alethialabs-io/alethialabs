"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getOwner } from "@/lib/auth/owner";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";

// Git provider tokens live in Better Auth's `account` table (Phase D full
// consolidation). Better Auth captures them on link and refreshes them on
// demand via getAccessToken — no dedicated provider_tokens table or manual
// refresh map anymore.

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

function isGitProvider(p: string): p is PublicGitProvider {
	return (GIT_PROVIDERS as readonly string[]).includes(p);
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
	const userId = await getOwner();
	if (!userId) return null;
	try {
		const res = await auth.api.getAccessToken({
			body: { providerId: provider, userId },
			headers: await headers(),
		});
		return res.accessToken ?? null;
	} catch {
		return null;
	}
}

/** Unlinks a git provider from the current user. */
export async function deleteProviderToken(provider: PublicGitProvider) {
	try {
		await auth.api.unlinkAccount({
			body: { providerId: provider },
			headers: await headers(),
		});
		revalidatePath("/dashboard/connectors");
		return { success: true };
	} catch (error) {
		console.error("Unexpected error unlinking provider:", error);
		return { error: "Unexpected error occurred" };
	}
}
