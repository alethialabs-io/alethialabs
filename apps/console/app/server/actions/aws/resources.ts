"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import type { AnyCachedResources } from "@/lib/cloud-providers";
import { normalizeCachedResources } from "@/lib/cloud-providers/cached-resources";
import type { CachedResources } from "@/types/jsonb.types";

export type CachedAwsResources = CachedResources & {
	cached_at: string | null;
};

/** Fetches cached AWS resources for a specific cloud identity. */
export async function getCachedAwsResources(
	cloudIdentityId: string,
): Promise<CachedAwsResources | null> {
	const userId = await getOwner();
	if (!userId) return null;

	const [row] = await withOwnerScope(userId, (tx) =>
		tx
			.select({
				cached_resources: cloudIdentities.cached_resources,
				cached_at: cloudIdentities.cached_at,
			})
			.from(cloudIdentities)
			.where(
				and(
					eq(cloudIdentities.id, cloudIdentityId),
					eq(cloudIdentities.provider, "aws"),
				),
			)
			.limit(1),
	);

	if (!row?.cached_resources) return null;
	// This reader is AWS-scoped (provider = 'aws'), so the union column is AWS-shaped here.
	return {
		...normalizeCachedResources(row.cached_resources as CachedResources),
		cached_at: row.cached_at?.toISOString() ?? null,
	};
}

/** Fetches cached resources for any cloud identity, regardless of provider. */
export async function getCachedResources(cloudIdentityId: string): Promise<{
	resources: AnyCachedResources | null;
	provider: string;
	cachedAt: string | null;
}> {
	const userId = await getOwner();
	if (!userId) return { resources: null, provider: "aws", cachedAt: null };

	const [row] = await withOwnerScope(userId, (tx) =>
		tx
			.select({
				cached_resources: cloudIdentities.cached_resources,
				cached_at: cloudIdentities.cached_at,
				provider: cloudIdentities.provider,
			})
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloudIdentityId))
			.limit(1),
	);

	if (!row) return { resources: null, provider: "aws", cachedAt: null };
	return {
		resources: row.cached_resources ?? null,
		provider: row.provider,
		cachedAt: row.cached_at?.toISOString() ?? null,
	};
}
