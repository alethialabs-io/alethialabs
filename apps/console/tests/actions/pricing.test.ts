// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for getRegionPrices: the only external dependency is the AWS public
// pricing API reached via global `fetch`. We stub `fetch` to return crafted pricing JSON and
// assert the SKU parsing/selection (EC2, NAT, EKS, Aurora, ElastiCache), the SSRF region guard,
// the fetch-failure fallback, and the 24h in-memory cache. The pure parsing helpers stay real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AwsPricingResponse } from "@/types/aws-pricing.types";

import { getRegionPrices } from "@/app/server/actions/pricing";

/** Build an OnDemand terms entry for a single SKU at the given USD price string. */
function onDemand(sku: string, usd: string) {
	return {
		[sku]: {
			[`${sku}.OFFER`]: {
				priceDimensions: {
					[`${sku}.OFFER.DIM`]: {
						pricePerUnit: { USD: usd },
						unit: "Hrs",
						description: "",
					},
				},
			},
		},
	};
}

const ec2Data: AwsPricingResponse = {
	products: {
		EC2SKU: {
			sku: "EC2SKU",
			attributes: {
				instanceType: "t3.medium",
				operatingSystem: "Linux",
				tenancy: "Shared",
				capacitystatus: "Used",
				preInstalledSw: "NA",
			},
		},
		// A second t3.medium row that should be ignored (already captured) and a windows row that
		// fails the OS filter — exercises the attribute gating.
		EC2DUP: {
			sku: "EC2DUP",
			attributes: {
				instanceType: "t3.medium",
				operatingSystem: "Linux",
				tenancy: "Shared",
				capacitystatus: "Used",
				preInstalledSw: "NA",
			},
		},
		EC2WIN: {
			sku: "EC2WIN",
			attributes: {
				instanceType: "t3.large",
				operatingSystem: "Windows",
				tenancy: "Shared",
				capacitystatus: "Used",
				preInstalledSw: "NA",
			},
		},
		NATSKU: { sku: "NATSKU", attributes: { usagetype: "USE1-NatGateway-Hours" } },
	},
	terms: {
		OnDemand: {
			...onDemand("EC2SKU", "0.0500"),
			...onDemand("EC2DUP", "0.9900"),
			...onDemand("EC2WIN", "0.2000"),
			...onDemand("NATSKU", "0.0450"),
		},
	},
};

const rdsData: AwsPricingResponse = {
	products: {
		RDSSKU: {
			sku: "RDSSKU",
			attributes: {
				usagetype: "EU-Aurora:ServerlessV2Usage",
				databaseEngine: "Aurora PostgreSQL",
			},
		},
	},
	terms: { OnDemand: { ...onDemand("RDSSKU", "0.1500") } },
};

const cacheData: AwsPricingResponse = {
	products: {
		CACHESKU: {
			sku: "CACHESKU",
			attributes: { cacheNodeType: "cache.t3.micro", cacheEngine: "Redis" },
		},
		// Higher-priced duplicate node type — selection must keep the lowest.
		CACHEHIGH: {
			sku: "CACHEHIGH",
			attributes: { cacheNodeType: "cache.t3.micro", cacheEngine: "Redis" },
		},
		// Memcached engine should be skipped.
		CACHEMEM: {
			sku: "CACHEMEM",
			attributes: { cacheNodeType: "cache.t3.small", cacheEngine: "Memcached" },
		},
	},
	terms: {
		OnDemand: {
			...onDemand("CACHESKU", "0.0130"),
			...onDemand("CACHEHIGH", "0.0500"),
			...onDemand("CACHEMEM", "0.0290"),
		},
	},
};

const eksData: AwsPricingResponse = {
	products: {
		EKSSKU: { sku: "EKSSKU", attributes: { usagetype: "USE1-EKS-Hours:perCluster" } },
	},
	terms: { OnDemand: { ...onDemand("EKSSKU", "0.1100") } },
};

/** Resolve the crafted pricing JSON for whichever AWS service the URL targets. */
function dataForUrl(url: string): AwsPricingResponse | null {
	if (url.includes("/AmazonEC2/")) return ec2Data;
	if (url.includes("/AmazonRDS/")) return rdsData;
	if (url.includes("/AmazonElastiCache/")) return cacheData;
	if (url.includes("/AmazonEKS/")) return eksData;
	return null;
}

const ORIGINAL_FETCH = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockImplementation(async (url: string) => ({
		ok: true,
		json: async () => dataForUrl(String(url)),
	}));
	global.fetch = fetchMock as never;
});

afterEach(() => {
	global.fetch = ORIGINAL_FETCH;
});

describe("getRegionPrices — successful parse", () => {
	it("selects the right SKU prices for each service and stamps metadata", async () => {
		const r = await getRegionPrices("us-east-1");

		// One fetch per service.
		expect(fetchMock).toHaveBeenCalledTimes(4);
		// EC2: first matching t3.medium wins (0.05), the 0.99 duplicate is ignored.
		expect(r.ec2["t3.medium"]).toBe(0.05);
		// Windows row was filtered out → no t3.large entry.
		expect(r.ec2["t3.large"]).toBeUndefined();
		// NAT / EKS / Aurora picked from their tagged usagetypes.
		expect(r.natGateway).toBe(0.045);
		expect(r.eksControlPlane).toBe(0.11);
		expect(r.auroraACU).toBe(0.15);
		// ElastiCache: lowest price for the node type wins; Memcached row skipped.
		expect(r.cache["cache.t3.micro"]).toBe(0.013);
		expect(r.cache["cache.t3.small"]).toBeUndefined();
		// Static + echoed fields.
		expect(r.wafWebACL).toBe(5.0);
		expect(r.region).toBe("us-east-1");
		expect(Number.isNaN(new Date(r.fetchedAt).getTime())).toBe(false);
	});

	it("targets the correct AWS pricing URL for the requested region", async () => {
		await getRegionPrices("ap-south-3");
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.includes("/AmazonEKS/current/ap-south-3/index.json"))).toBe(true);
		expect(urls.every((u) => u.startsWith("https://pricing.us-east-1.amazonaws.com/"))).toBe(true);
	});
});

describe("getRegionPrices — fallback paths", () => {
	it("returns fallback prices without fetching when the region is malformed (SSRF guard)", async () => {
		const r = await getRegionPrices("not-a-region!");
		expect(fetchMock).not.toHaveBeenCalled();
		// Fallback shape: known static defaults.
		expect(r.region).toBe("not-a-region!");
		expect(r.wafWebACL).toBe(5.0);
		expect(r.ec2["t3.medium"]).toBe(0.0456);
		expect(r.cache["cache.r6g.large"]).toBe(0.183);
	});

	it("does not crash on a malformed term missing priceDimensions (drops that price)", async () => {
		// A term with no priceDimensions used to throw (Object.values(undefined)); now → null.
		const malformed: AwsPricingResponse = {
			products: {
				EC2SKU: {
					sku: "EC2SKU",
					attributes: {
						instanceType: "t3.medium",
						operatingSystem: "Linux",
						tenancy: "Shared",
						capacitystatus: "Used",
						preInstalledSw: "NA",
					},
				},
			},
			// A term object with no priceDimensions (cast: deliberately malformed input).
			terms: { OnDemand: { EC2SKU: { "EC2SKU.OFFER": {} as never } } },
		};
		fetchMock.mockImplementation(async (url: string) => ({
			ok: true,
			json: async () =>
				String(url).includes("/AmazonEC2/")
					? malformed
					: { products: {}, terms: { OnDemand: {} } },
		}));
		const r = await getRegionPrices("us-east-2");
		expect(r.ec2["t3.medium"]).toBeUndefined(); // null price dropped, no throw
	});

	it("falls back when a pricing fetch responds non-OK", async () => {
		fetchMock.mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
		const r = await getRegionPrices("eu-west-1");
		// Fallback defaults, not parsed values.
		expect(r.eksControlPlane).toBe(0.1);
		expect(r.auroraACU).toBe(0.14);
		expect(r.ec2["m5a.4xlarge"]).toBe(0.768);
	});
});

describe("getRegionPrices — caching", () => {
	it("serves the second call for a region from the in-memory cache (no refetch)", async () => {
		const first = await getRegionPrices("ca-central-2");
		expect(fetchMock).toHaveBeenCalledTimes(4);

		const second = await getRegionPrices("ca-central-2");
		// No additional fetches; identical payload returned.
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(second).toEqual(first);
	});
});
