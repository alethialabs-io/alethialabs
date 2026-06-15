import { describe, expect, it } from "vitest";

const HOURS_PER_MONTH = 730;
const EKS_STANDARD_HOURLY = 0.1;
const EKS_EXTENDED_HOURLY = 0.6;
const NAT_GATEWAY_HOURLY = 0.045;
const T3_MEDIUM_HOURLY = 0.042;
const NODE_COUNT = 3;
const AURORA_ACU_HOURLY = 0.12;
const REDIS_T3_MEDIUM_HOURLY = 0.034;
const WAF_MONTHLY = 5;

function calculateCost(values: {
	eks_version?: string;
	create_vpc?: boolean;
	create_rds?: boolean;
	db_min_capacity?: number;
	enable_redis?: boolean;
	enable_cloudfront_waf?: boolean;
}) {
	let total = 0;

	const eksVersion = values.eks_version ?? "1.32";
	const isExtended = parseFloat(eksVersion) < 1.3;
	total += (isExtended ? EKS_EXTENDED_HOURLY : EKS_STANDARD_HOURLY) * HOURS_PER_MONTH;

	if (values.create_vpc !== false) {
		total += NAT_GATEWAY_HOURLY * HOURS_PER_MONTH;
	}

	total += T3_MEDIUM_HOURLY * NODE_COUNT * HOURS_PER_MONTH;

	if (values.create_rds !== false) {
		const min = values.db_min_capacity ?? 2;
		total += min * AURORA_ACU_HOURLY * HOURS_PER_MONTH;
	}

	if (values.enable_redis) {
		total += REDIS_T3_MEDIUM_HOURLY * HOURS_PER_MONTH;
	}

	if (values.enable_cloudfront_waf) {
		total += WAF_MONTHLY;
	}

	return Math.round(total);
}

describe("Cost Preview calculations", () => {
	it("calculates base cost with defaults", () => {
		const cost = calculateCost({});
		expect(cost).toBeGreaterThan(300);
		expect(cost).toBeLessThan(500);
	});

	it("EKS extended support costs 6x more", () => {
		const standard = calculateCost({ eks_version: "1.32" });
		const extended = calculateCost({ eks_version: "1.28" });
		expect(extended - standard).toBeCloseTo(
			(EKS_EXTENDED_HOURLY - EKS_STANDARD_HOURLY) * HOURS_PER_MONTH,
			0,
		);
	});

	it("disabling RDS reduces cost", () => {
		const with_rds = calculateCost({ create_rds: true, db_min_capacity: 2 });
		const without_rds = calculateCost({ create_rds: false });
		expect(without_rds).toBeLessThan(with_rds);
	});

	it("higher ACU min increases RDS cost", () => {
		const low = calculateCost({ db_min_capacity: 2 });
		const high = calculateCost({ db_min_capacity: 8 });
		expect(high).toBeGreaterThan(low);
	});

	it("enabling Redis adds cost", () => {
		const without = calculateCost({ enable_redis: false });
		const with_redis = calculateCost({ enable_redis: true });
		expect(with_redis - without).toBeCloseTo(
			REDIS_T3_MEDIUM_HOURLY * HOURS_PER_MONTH,
			0,
		);
	});

	it("WAF adds flat $5/month", () => {
		const without = calculateCost({ enable_cloudfront_waf: false });
		const with_waf = calculateCost({ enable_cloudfront_waf: true });
		expect(with_waf - without).toBe(WAF_MONTHLY);
	});

	it("disabling VPC removes NAT gateway cost", () => {
		const with_vpc = calculateCost({ create_vpc: true });
		const without_vpc = calculateCost({ create_vpc: false });
		expect(with_vpc - without_vpc).toBeCloseTo(
			NAT_GATEWAY_HOURLY * HOURS_PER_MONTH,
			0,
		);
	});
});
