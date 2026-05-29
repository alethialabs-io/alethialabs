"use server";

import { createClient } from "@/lib/supabase/server";

export type CachedAwsResources = {
	regions: string[];
	vpcs: Record<string, Array<{ id: string; cidr: string; name: string; isDefault: boolean }>>;
	subnets: Record<string, Record<string, Array<{ id: string; cidr: string; az: string }>>>;
	hosted_zones: Array<{ id: string; name: string; recordCount: number; isPrivate: boolean }>;
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

	const resources = data.cached_resources as Record<string, unknown>;
	return {
		regions: (resources.regions as string[]) ?? [],
		vpcs: (resources.vpcs as CachedAwsResources["vpcs"]) ?? {},
		subnets: (resources.subnets as CachedAwsResources["subnets"]) ?? {},
		hosted_zones: (resources.hosted_zones as CachedAwsResources["hosted_zones"]) ?? [],
		cached_at: data.cached_at,
	};
}
