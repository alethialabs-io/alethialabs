// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

type CachedResources = {
	regions: string[];
	vpcs: Record<string, Array<{ ID: string; CIDR: string; Name: string }>>;
	subnets: Record<string, Record<string, Array<{ ID: string; CIDR: string }>>>;
	hosted_zones: Array<{ ID: string; Name: string; RecordCount: number }>;
};

function parseCachedResources(
	raw: Record<string, unknown> | null,
): CachedResources | null {
	if (!raw) return null;
	return {
		regions: (raw.regions as string[]) ?? [],
		vpcs: (raw.vpcs as CachedResources["vpcs"]) ?? {},
		subnets: (raw.subnets as CachedResources["subnets"]) ?? {},
		hosted_zones:
			(raw.hosted_zones as CachedResources["hosted_zones"]) ?? [],
	};
}

describe("Cached AWS resources parsing", () => {
	it("parses full cached resources", () => {
		const result = parseCachedResources({
			regions: ["us-east-1", "eu-west-1"],
			vpcs: {
				"us-east-1": [
					{ ID: "vpc-1", CIDR: "10.0.0.0/16", Name: "prod" },
				],
			},
			subnets: {},
			hosted_zones: [
				{ ID: "Z123", Name: "example.com", RecordCount: 10 },
			],
		});

		expect(result?.regions).toHaveLength(2);
		expect(result?.vpcs["us-east-1"]).toHaveLength(1);
		expect(result?.hosted_zones[0].Name).toBe("example.com");
	});

	it("returns null for null input", () => {
		expect(parseCachedResources(null)).toBeNull();
	});

	it("handles partial data with defaults", () => {
		const result = parseCachedResources({ regions: ["us-east-1"] });
		expect(result?.regions).toEqual(["us-east-1"]);
		expect(result?.vpcs).toEqual({});
		expect(result?.subnets).toEqual({});
		expect(result?.hosted_zones).toEqual([]);
	});

	it("handles empty object", () => {
		const result = parseCachedResources({});
		expect(result?.regions).toEqual([]);
		expect(result?.vpcs).toEqual({});
	});
});
