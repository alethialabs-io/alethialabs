"use server";

import { createClient } from "@/lib/supabase/server";
import { PublicGitProvider } from "@/lib/validations/db.schemas";

export async function hasCloudIdentity() {
	try {
		const supabase = await createClient();

		const { count } = await supabase
			.from("cloud_identities")
			.select("*", { count: "exact", head: true })
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

		return data?.map((p) => p.provider) || [];
	} catch (error) {
		console.error("Unexpected error fetching linked providers:", error);
		return [];
	}
}

export async function saveProviderToken(
	provider: PublicGitProvider,
	accessToken: string,
	refreshToken?: string,
) {
	try {
		const supabase = await createClient();

		const { error } = await supabase.from("provider_tokens").upsert(
			{
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

	// 2. Check database
	const { data } = await supabase
		.from("provider_tokens")
		.select("access_token")
		.eq("provider", provider)
		.single();

	return data?.access_token || null;
}
