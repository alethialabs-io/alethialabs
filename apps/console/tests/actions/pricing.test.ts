// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The getRegionPrices SERVER ACTION is the browser's door to AWS list prices; the fetch, parsing
// and cache are tested at lib/pricing/region-prices.ts. What this file pins is the door: an
// anonymous caller is refused BEFORE the console fetches anything (#5219), and a signed-in one gets
// exactly what the lib returns.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/pricing/region-prices", () => ({ getRegionPrices: vi.fn() }));

import { getRegionPrices } from "@/app/server/actions/pricing";
import { requireOwner } from "@/lib/auth/owner";
import { getRegionPrices as readRegionPrices, type RegionPrices } from "@/lib/pricing/region-prices";

const PRICES: RegionPrices = {
	eksControlPlane: 0.1,
	natGateway: 0.048,
	auroraACU: 0.14,
	wafWebACL: 5,
	ec2: {},
	cache: {},
	region: "eu-west-1",
	fetchedAt: "2026-09-30T00:00:00.000Z",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getRegionPrices (server action)", () => {
	it("refuses an anonymous caller without fetching", async () => {
		vi.mocked(requireOwner).mockRejectedValue(new Error("Unauthorized"));
		await expect(getRegionPrices("eu-west-1")).rejects.toThrow("Unauthorized");
		expect(readRegionPrices).not.toHaveBeenCalled();
	});

	it("returns the lib's prices to a signed-in caller", async () => {
		vi.mocked(requireOwner).mockResolvedValue("user-1");
		vi.mocked(readRegionPrices).mockResolvedValue(PRICES);
		await expect(getRegionPrices("eu-west-1")).resolves.toEqual(PRICES);
		expect(readRegionPrices).toHaveBeenCalledWith("eu-west-1");
	});
});
