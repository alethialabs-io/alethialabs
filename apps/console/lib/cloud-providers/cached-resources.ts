// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CachedResources } from "@/types/jsonb.types";

/**
 * Fills a cached AWS-resources payload with empty defaults for any missing collection,
 * so consumers can read `.vpcs[region]` etc. without null checks. Pure — extracted from
 * getCachedAwsResources so it's unit-testable directly.
 */
export function normalizeCachedResources(
	res: Partial<CachedResources> | null | undefined,
): CachedResources {
	return {
		regions: res?.regions ?? [],
		vpcs: res?.vpcs ?? {},
		subnets: res?.subnets ?? {},
		hosted_zones: res?.hosted_zones ?? [],
		...(res?.iam_users ? { iam_users: res.iam_users } : {}),
	};
}
