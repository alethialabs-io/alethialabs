"use server";

import { createClient } from "@/lib/supabase/server";
import type { CachedResources } from "@/types/database-custom.types";

export type CachedAwsResources = CachedResources & {
	cached_at: string | null;
};

export async function getCachedAwsResources(
	cloudIdentityId: string,
): Promise<CachedAwsResources | null> {
	const supabase = await createClient();

	const { data, error } = await supabase
		.from("cloud_identities")
		.select("cached_resources, cached_at")
		.eq("id", cloudIdentityId)
		.single();

	if (error || !data?.cached_resources) return null;

	return {
		regions: data.cached_resources.regions ?? [],
		vpcs: data.cached_resources.vpcs ?? {},
		subnets: data.cached_resources.subnets ?? {},
		hosted_zones: data.cached_resources.hosted_zones ?? [],
		cached_at: data.cached_at ?? null,
	};
}
