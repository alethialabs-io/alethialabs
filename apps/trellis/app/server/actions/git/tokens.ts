"use server";

import { createClient } from "@/lib/supabase/server";

export type ProviderTokenOption = {
	provider: string;
	username: string;
};

export async function getProviderTokenOptions(): Promise<
	ProviderTokenOption[]
> {
	const supabase = await createClient();

	const [tokensResult, userResult] = await Promise.all([
		supabase.from("provider_tokens").select("provider"),
		supabase.auth.getUser(),
	]);

	const tokens = tokensResult.data ?? [];
	const user = userResult.data?.user;

	const identityMap = new Map<string, string>();
	if (user?.identities) {
		for (const identity of user.identities) {
			if (["github", "gitlab", "bitbucket"].includes(identity.provider)) {
				identityMap.set(
					identity.provider,
					identity.identity_data?.user_name ||
						identity.identity_data?.preferred_username ||
						identity.identity_data?.name ||
						identity.provider,
				);
			}
		}
	}

	return tokens
		.filter((t) => identityMap.has(t.provider))
		.map((t) => ({
			provider: t.provider,
			username: identityMap.get(t.provider) ?? t.provider,
		}));
}
