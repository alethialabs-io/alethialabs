"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createClient } from "@/lib/supabase/server";
import type { CachedResources } from "@/types/database-custom.types";
import type { AnyCachedResources } from "@/lib/cloud-providers";

export type CachedAwsResources = CachedResources & {
	cached_at: string | null;
};

/** Fetches cached AWS resources for a specific cloud identity. */
export async function getCachedAwsResources(
	cloudIdentityId: string,
): Promise<CachedAwsResources | null> {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("cloud_identities")
		.select("cached_resources, cached_at")
		.eq("id", cloudIdentityId)
		.eq("provider", "aws")
		.single();

	if (error || !data?.cached_resources) return null;

	const res = data.cached_resources as CachedResources;
	return {
		regions: res.regions ?? [],
		vpcs: res.vpcs ?? {},
		subnets: res.subnets ?? {},
		hosted_zones: res.hosted_zones ?? [],
		cached_at: data.cached_at ?? null,
	};
}

/** Fetches cached resources for any cloud identity, regardless of provider. */
export async function getCachedResources(
	cloudIdentityId: string,
): Promise<{
	resources: AnyCachedResources | null;
	provider: string;
	cachedAt: string | null;
}> {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("cloud_identities")
		.select("cached_resources, cached_at, provider")
		.eq("id", cloudIdentityId)
		.single();

	if (error || !data) return { resources: null, provider: "aws", cachedAt: null };

	return {
		resources: data.cached_resources ?? null,
		provider: data.provider,
		cachedAt: data.cached_at,
	};
}
