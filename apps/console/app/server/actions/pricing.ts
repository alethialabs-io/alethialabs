"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import type { AwsPricingResponse } from "@/types/aws-pricing.types";

export type RegionPrices = {
	eksControlPlane: number;
	natGateway: number;
	auroraACU: number;
	wafWebACL: number;
	ec2: Record<string, number>;
	cache: Record<string, number>;
	region: string;
	fetchedAt: string;
};

const CACHE_TTL = 24 * 60 * 60 * 1000;
const priceCache = new Map<string, { data: RegionPrices; fetchedAt: number }>();

const EC2_INSTANCE_TYPES = [
	"t3.medium", "t3.large", "t3.xlarge",
	"m5a.large", "m5a.xlarge", "m5a.2xlarge", "m5a.4xlarge",
	"c5.large", "c5.xlarge",
	"r5.large", "r5.xlarge",
];

const CACHE_NODE_TYPES = [
	"cache.t3.micro", "cache.t3.small", "cache.t3.medium", "cache.r6g.large",
];

async function fetchAwsPricingJson(service: string, region: string): Promise<AwsPricingResponse> {
	const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${service}/current/${region}/index.json`;
	const res = await fetch(url, { next: { revalidate: 86400 } });
	if (!res.ok) throw new Error(`Failed to fetch ${service} pricing`);
	return res.json();
}

function getOnDemandPrice(data: AwsPricingResponse, sku: string): number | null {
	const terms = data.terms?.OnDemand?.[sku];
	if (!terms) return null;
	const term = Object.values(terms)[0];
	if (!term) return null;
	const dim = Object.values(term.priceDimensions)[0];
	if (!dim) return null;
	const usd = parseFloat(dim.pricePerUnit.USD);
	return isNaN(usd) ? null : usd;
}

export async function getRegionPrices(region: string): Promise<RegionPrices> {
	const cached = priceCache.get(region);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
		return cached.data;
	}

	try {
		const [ec2Data, rdsData, cacheData, eksData] = await Promise.all([
			fetchAwsPricingJson("AmazonEC2", region),
			fetchAwsPricingJson("AmazonRDS", region),
			fetchAwsPricingJson("AmazonElastiCache", region),
			fetchAwsPricingJson("AmazonEKS", region),
		]);

		// EC2 instance prices
		const ec2Prices: Record<string, number> = {};
		for (const [sku, product] of Object.entries(ec2Data.products)) {
			const a = product.attributes;
			if (
				EC2_INSTANCE_TYPES.includes(a.instanceType) &&
				a.operatingSystem === "Linux" &&
				a.tenancy === "Shared" &&
				a.capacitystatus === "Used" &&
				a.preInstalledSw === "NA"
			) {
				const price = getOnDemandPrice(ec2Data, sku);
				if (price !== null && !(a.instanceType in ec2Prices)) {
					ec2Prices[a.instanceType] = price;
				}
			}
		}

		// NAT Gateway
		let natGateway = 0.048;
		for (const [sku, product] of Object.entries(ec2Data.products)) {
			if ((product.attributes.usagetype || "").includes("NatGateway-Hours")) {
				const price = getOnDemandPrice(ec2Data, sku);
				if (price !== null) { natGateway = price; break; }
			}
		}

		// EKS Control Plane
		let eksControlPlane = 0.10;
		for (const [sku, product] of Object.entries(eksData.products)) {
			if ((product.attributes.usagetype || "").includes("EKS-Hours:perCluster")) {
				const price = getOnDemandPrice(eksData, sku);
				if (price !== null) { eksControlPlane = price; break; }
			}
		}

		// Aurora Serverless v2 ACU
		let auroraACU = 0.14;
		for (const [sku, product] of Object.entries(rdsData.products)) {
			const a = product.attributes;
			if (
				(a.usagetype || "").includes("Aurora:ServerlessV2Usage") &&
				(a.databaseEngine || "").includes("PostgreSQL")
			) {
				const price = getOnDemandPrice(rdsData, sku);
				if (price !== null) { auroraACU = price; break; }
			}
		}

		// ElastiCache Redis prices (take lowest on-demand per node type)
		const cachePrices: Record<string, number> = {};
		for (const [sku, product] of Object.entries(cacheData.products)) {
			const a = product.attributes;
			const nodeType = a.cacheNodeType || a.instanceType || "";
			if (CACHE_NODE_TYPES.includes(nodeType) && a.cacheEngine === "Redis") {
				const price = getOnDemandPrice(cacheData, sku);
				if (price !== null) {
					if (!(nodeType in cachePrices) || price < cachePrices[nodeType]) {
						cachePrices[nodeType] = price;
					}
				}
			}
		}

		const result: RegionPrices = {
			eksControlPlane,
			natGateway,
			auroraACU,
			wafWebACL: 5.0,
			ec2: ec2Prices,
			cache: cachePrices,
			region,
			fetchedAt: new Date().toISOString(),
		};

		priceCache.set(region, { data: result, fetchedAt: Date.now() });
		return result;
	} catch (err) {
		console.error("Failed to fetch pricing:", err);
		return getFallbackPrices(region);
	}
}

function getFallbackPrices(region: string): RegionPrices {
	return {
		eksControlPlane: 0.10,
		natGateway: 0.048,
		auroraACU: 0.14,
		wafWebACL: 5.0,
		ec2: {
			"t3.medium": 0.0456, "t3.large": 0.0912, "t3.xlarge": 0.1824,
			"m5a.large": 0.096, "m5a.xlarge": 0.192, "m5a.2xlarge": 0.384, "m5a.4xlarge": 0.768,
			"c5.large": 0.096, "c5.xlarge": 0.192,
			"r5.large": 0.141, "r5.xlarge": 0.282,
		},
		cache: {
			"cache.t3.micro": 0.014, "cache.t3.small": 0.029,
			"cache.t3.medium": 0.058, "cache.r6g.large": 0.183,
		},
		region,
		fetchedAt: new Date().toISOString(),
	};
}
