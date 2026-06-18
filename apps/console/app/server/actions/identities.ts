"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withOwnerScope } from "@/lib/db";
import { cloudIdentities, providerTokens } from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";

export async function hasCloudIdentity() {
	try {
		const supabase = await createClient();
		const {
			data: { user },
		} = await supabase.auth.getUser();
		if (!user) return false;

		return await withOwnerScope(user.id, async (tx) => {
			const [row] = await tx
				.select({ value: count() })
				.from(cloudIdentities)
				.where(
					and(
						eq(cloudIdentities.provider, "aws"),
						eq(cloudIdentities.is_verified, true),
					),
				);
			return (row?.value ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error checking cloud identities:", error);
		return false;
	}
}

export async function getLinkedProviders() {
	try {
		const supabase = await createClient();
		const {
			data: { user },
		} = await supabase.auth.getUser();

		const providers = new Set<PublicGitProvider>();
		if (user) {
			const rows = await withOwnerScope(user.id, (tx) =>
				tx.select({ provider: providerTokens.provider }).from(providerTokens),
			);
			for (const r of rows) providers.add(r.provider);

			// Fallback: add the active user provider if it's a git provider
			const activeProvider = user.app_metadata?.provider;
			if (
				activeProvider === "github" ||
				activeProvider === "gitlab" ||
				activeProvider === "bitbucket"
			) {
				providers.add(activeProvider);
			}
		}

		return Array.from(providers);
	} catch (error) {
		console.error("Unexpected error fetching linked providers:", error);
		return [];
	}
}

export async function saveProviderToken(
	userId: string,
	provider: PublicGitProvider,
	accessToken: string,
	refreshToken?: string,
	expiresAt?: string | null,
) {
	try {
		await withOwnerScope(userId, (tx) =>
			tx
				.insert(providerTokens)
				.values({
					user_id: userId,
					provider,
					access_token: accessToken,
					refresh_token: refreshToken ?? null,
					expires_at: expiresAt ? new Date(expiresAt) : null,
					updated_at: new Date(),
				})
				.onConflictDoUpdate({
					target: [providerTokens.user_id, providerTokens.provider],
					set: {
						access_token: accessToken,
						refresh_token: refreshToken ?? null,
						expires_at: expiresAt ? new Date(expiresAt) : null,
						updated_at: new Date(),
					},
				}),
		);

		return { success: true };
	} catch (error) {
		console.error("Unexpected error saving provider token:", error);
		throw error;
	}
}

export async function getProviderToken(
	provider: PublicGitProvider,
): Promise<string | null> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return null;

	// 1. Check database
	const dbToken = await withOwnerScope(user.id, async (tx) => {
		const [row] = await tx
			.select({ access_token: providerTokens.access_token })
			.from(providerTokens)
			.where(eq(providerTokens.provider, provider))
			.limit(1);
		return row?.access_token ?? null;
	});
	if (dbToken) return dbToken;

	// 2. Fallback: Check active session
	const {
		data: { session },
	} = await supabase.auth.getSession();

	if (session?.provider_token) {
		const activeProvider = user.app_metadata?.provider;
		if (activeProvider === provider) {
			return session.provider_token;
		}
	}

	return null;
}

const PROVIDER_OAUTH: Record<
	string,
	{
		tokenUrl: string;
		clientIdEnv: string;
		clientSecretEnv: string;
		buildBody: (
			clientId: string,
			clientSecret: string,
			refreshToken: string,
		) => Record<string, string>;
		useBasicAuth?: boolean;
	}
> = {
	github: {
		tokenUrl: "https://github.com/login/oauth/access_token",
		clientIdEnv: "GITHUB_CLIENT_ID",
		clientSecretEnv: "GITHUB_CLIENT_SECRET",
		buildBody: (clientId, clientSecret, refreshToken) => ({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	},
	gitlab: {
		tokenUrl: "https://gitlab.itgix.com/oauth/token",
		clientIdEnv: "GITLAB_APPLICATION_ID",
		clientSecretEnv: "GITLAB_SECRET",
		buildBody: (clientId, clientSecret, refreshToken) => ({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	},
	bitbucket: {
		tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
		clientIdEnv: "BITBUCKET_KEY",
		clientSecretEnv: "BITBUCKET_SECRET",
		buildBody: (_clientId, _clientSecret, refreshToken) => ({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
		useBasicAuth: true,
	},
};

export async function getValidProviderToken(
	provider: PublicGitProvider,
): Promise<string | null> {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return null;

	const data = await withOwnerScope(user.id, async (tx) => {
		const [row] = await tx
			.select({
				access_token: providerTokens.access_token,
				refresh_token: providerTokens.refresh_token,
				expires_at: providerTokens.expires_at,
			})
			.from(providerTokens)
			.where(eq(providerTokens.provider, provider))
			.limit(1);
		return row ?? null;
	});

	if (!data?.access_token) return null;

	if (!data.expires_at || data.expires_at > new Date()) {
		return data.access_token;
	}

	if (!data.refresh_token) return data.access_token;

	const oauth = PROVIDER_OAUTH[provider];
	if (!oauth) return data.access_token;

	const clientId = process.env[oauth.clientIdEnv];
	const clientSecret = process.env[oauth.clientSecretEnv];
	if (!clientId || !clientSecret) return data.access_token;

	try {
		const body = oauth.buildBody(clientId, clientSecret, data.refresh_token);
		const headers: Record<string, string> = {
			Accept: "application/json",
		};

		let fetchBody: string;
		if (oauth.useBasicAuth) {
			headers["Authorization"] =
				"Basic " +
				Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			fetchBody = new URLSearchParams(body).toString();
		} else {
			headers["Content-Type"] = "application/json";
			fetchBody = JSON.stringify(body);
		}

		const res = await fetch(oauth.tokenUrl, {
			method: "POST",
			headers,
			body: fetchBody,
		});

		if (!res.ok) return data.access_token;

		const result: {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		} = await res.json();
		if (!result.access_token) return data.access_token;

		const newAccessToken = result.access_token;
		await withOwnerScope(user.id, (tx) =>
			tx
				.insert(providerTokens)
				.values({
					user_id: user.id,
					provider,
					access_token: newAccessToken,
					refresh_token: result.refresh_token || data.refresh_token,
					expires_at: result.expires_in
						? new Date(Date.now() + result.expires_in * 1000)
						: null,
					updated_at: new Date(),
				})
				.onConflictDoUpdate({
					target: [providerTokens.user_id, providerTokens.provider],
					set: {
						access_token: newAccessToken,
						refresh_token: result.refresh_token || data.refresh_token,
						expires_at: result.expires_in
							? new Date(Date.now() + result.expires_in * 1000)
							: null,
						updated_at: new Date(),
					},
				}),
		);

		return newAccessToken;
	} catch {
		return data.access_token;
	}
}

export async function deleteProviderToken(provider: PublicGitProvider) {
	try {
		const supabase = await createClient();
		const {
			data: { user },
		} = await supabase.auth.getUser();

		if (!user) {
			return { error: "User not authenticated" };
		}

		await withOwnerScope(user.id, (tx) =>
			tx
				.delete(providerTokens)
				.where(
					and(
						eq(providerTokens.user_id, user.id),
						eq(providerTokens.provider, provider),
					),
				),
		);

		revalidatePath("/dashboard/connectors");
		return { success: true };
	} catch (error) {
		console.error("Unexpected error deleting provider token:", error);
		return { error: "Unexpected error occurred" };
	}
}
