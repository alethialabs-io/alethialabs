"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { PublicGitProvider } from "@/lib/validations/db.schemas";

export async function hasCloudIdentity() {
	try {
		const supabase = await createClient();

		const { count } = await supabase
			.from("cloud_identities")
			.select("*", { count: "exact", head: true })
			.eq("provider", "aws")
			.eq("is_verified", true);
		return (count || 0) > 0;
	} catch (error) {
		console.error("Error checking cloud identities:", error);
		return false;
	}
}

export async function getLinkedProviders() {
	try {
		const supabase = await createClient();

		const { data, error } = await supabase
			.from("provider_tokens")
			.select("provider");

		if (error) {
			console.error("Error fetching linked providers:", error);
			return [];
		}

		const providers = new Set<string>(data?.map((p) => p.provider) || []);

		// Fallback: add the active user provider if it's a git provider
		const {
			data: { user },
		} = await supabase.auth.getUser();
		if (user) {
			const activeProvider = user.app_metadata?.provider;
			if (
				activeProvider &&
				["github", "gitlab", "bitbucket"].includes(activeProvider)
			) {
				providers.add(activeProvider);
			}
		}

		return Array.from(providers) as PublicGitProvider[];
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
		const supabase = await createClient();

		const { error } = await supabase.from("provider_tokens").upsert(
			{
				user_id: userId,
				provider,
				access_token: accessToken,
				refresh_token: refreshToken,
				expires_at: expiresAt ?? null,
				updated_at: new Date().toISOString(),
			},
			{
				onConflict: "user_id, provider",
			},
		);

		if (error) {
			console.error("Error saving provider token:", error);
			throw new Error("Failed to save provider token");
		}

		return { success: true };
	} catch (error) {
		console.error("Unexpected error saving provider token:", error);
		throw error;
	}
}

export async function getProviderToken(
	provider: "github" | "gitlab" | "bitbucket",
): Promise<string | null> {
	const supabase = await createClient();

	// 1. Check database
	const { data } = await supabase
		.from("provider_tokens")
		.select("access_token")
		.eq("provider", provider)
		.single();

	if (data?.access_token) {
		return data.access_token;
	}

	// 2. Fallback: Check active session
	const {
		data: { session },
	} = await supabase.auth.getSession();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (session?.provider_token && user) {
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
	provider: "github" | "gitlab" | "bitbucket",
): Promise<string | null> {
	const supabase = await createClient();

	const { data } = await supabase
		.from("provider_tokens")
		.select("access_token, refresh_token, expires_at")
		.eq("provider", provider)
		.single();

	if (!data?.access_token) return null;

	if (!data.expires_at || new Date(data.expires_at) > new Date()) {
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

		const result = await res.json();
		if (!result.access_token) return data.access_token;

		const {
			data: { user },
		} = await supabase.auth.getUser();

		if (user) {
			await supabase.from("provider_tokens").upsert(
				{
					user_id: user.id,
					provider,
					access_token: result.access_token,
					refresh_token:
						result.refresh_token || data.refresh_token,
					expires_at: result.expires_in
						? new Date(
								Date.now() + result.expires_in * 1000,
							).toISOString()
						: null,
					updated_at: new Date().toISOString(),
				},
				{ onConflict: "user_id, provider" },
			);
		}

		return result.access_token;
	} catch {
		return data.access_token;
	}
}

export async function deleteProviderToken(
	provider: "github" | "gitlab" | "bitbucket",
) {
	try {
		const supabase = await createClient();
		const {
			data: { user },
		} = await supabase.auth.getUser();

		if (!user) {
			return { error: "User not authenticated" };
		}

		const { error } = await supabase
			.from("provider_tokens")
			.delete()
			.eq("user_id", user.id)
			.eq("provider", provider);

		if (error) {
			console.error("Error deleting provider token:", error);
			return { error: "Failed to delete provider token" };
		}

		revalidatePath("/dashboard/integrations");
		return { success: true };
	} catch (error) {
		console.error("Unexpected error deleting provider token:", error);
		return { error: "Unexpected error occurred" };
	}
}
