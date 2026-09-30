"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser's door to AWS region prices (the agent artifact panel). The fetch, parsing and cache
// live in lib/pricing/region-prices.ts; this action only establishes that a signed-in user is
// asking, because an anonymous caller could otherwise make the console pull the AWS offer files —
// hundreds of megabytes per region — on demand (#5219).

import { requireOwner } from "@/lib/auth/owner";
import {
	getRegionPrices as readRegionPrices,
	type RegionPrices,
} from "@/lib/pricing/region-prices";

export type { RegionPrices } from "@/lib/pricing/region-prices";

/**
 * AWS on-demand prices for `region` (24h-cached, static fallback on a failed fetch). Any signed-in
 * user: the figures are public list prices, so authentication is the whole gate.
 */
export async function getRegionPrices(region: string): Promise<RegionPrices> {
	await requireOwner();
	return readRegionPrices(region);
}
