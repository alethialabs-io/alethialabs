"use server";

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
) {
	try {
		const supabase = await createClient();

		const { error } = await supabase.from("provider_tokens").upsert(
			{
				user_id: userId,
				provider,
				access_token: accessToken,
				refresh_token: refreshToken,
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

		return { success: true };
	} catch (error) {
		console.error("Unexpected error deleting provider token:", error);
		return { error: "Unexpected error occurred" };
	}
}
