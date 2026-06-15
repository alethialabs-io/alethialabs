"use server";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createClient } from "@/lib/supabase/server";

export type CloudIdentityOption = {
	id: string;
	name: string;
	displayId: string;
	provider: string;
};

/** Fetches all verified cloud identities for the current user across all providers. */
export async function getVerifiedCloudIdentities(): Promise<
	CloudIdentityOption[]
> {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("cloud_identities")
		.select("id, name, provider, credentials")
		.eq("is_verified", true);

	if (error || !data) return [];

	return data.map((identity) => {
		const creds = identity.credentials;
		const displayId =
			creds?.account_id ??
			creds?.project_id ??
			creds?.subscription_id ??
			"";
		return {
			id: identity.id,
			name: identity.name,
			displayId,
			provider: identity.provider,
		};
	});
}

/** Fetches verified cloud identities for a specific provider. */
export async function getVerifiedCloudIdentitiesByProvider(
	provider: "aws" | "gcp" | "azure",
): Promise<CloudIdentityOption[]> {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("cloud_identities")
		.select("id, name, provider, credentials")
		.eq("provider", provider)
		.eq("is_verified", true);

	if (error || !data) return [];

	return data.map((identity) => {
		const creds = identity.credentials;
		const displayId =
			creds?.account_id ??
			creds?.project_id ??
			creds?.subscription_id ??
			"";
		return {
			id: identity.id,
			name: identity.name,
			displayId,
			provider: identity.provider,
		};
	});
}
