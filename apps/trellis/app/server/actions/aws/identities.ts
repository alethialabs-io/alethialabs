"use server";

import { createClient } from "@/lib/supabase/server";

export type CloudIdentityOption = {
	id: string;
	name: string;
	accountId: string;
	provider: string;
};

export async function getVerifiedCloudIdentities(): Promise<
	CloudIdentityOption[]
> {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("cloud_identities")
		.select("id, name, provider, credentials")
		.eq("is_verified", true);

	if (error || !data) return [];

	return data.map((identity) => ({
		id: identity.id,
		name: identity.name,
		accountId: identity.credentials?.account_id ?? "",
		provider: identity.provider,
	}));
}
