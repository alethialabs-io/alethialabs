// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// AWS service-quota lane (#981): the pure normalizer that picks our networking quota codes out of a
// region's collected ListServiceQuotas map. AWS reports the limit only, so used/available are NULL.

import { describe, expect, it } from "vitest";
import {
	type AwsQuotaValue,
	normalizeAwsQuotas,
} from "@/lib/cloud-providers/capabilities/service-quotas/aws";

describe("normalizeAwsQuotas", () => {
	const byCode = new Map<string, AwsQuotaValue>([
		["L-0263D0A3", { name: "EC2-VPC Elastic IPs", value: 5 }],
		["L-FE5A380F", { name: "NAT gateways per AZ", value: 5 }],
		["L-E79EC296", { name: "VPC security groups per Region", value: 2500 }],
		["L-53DA6B97", { name: "Application Load Balancers per Region", value: 50 }],
		["L-69A177A2", { name: "Network Load Balancers per Region", value: 50 }],
		// L-E9E9831D (Classic LB) intentionally absent — must be skipped, not fabricated.
		["L-IGNORED", { name: "some other quota", value: 999 }],
	]);

	it("maps each present networking code to its kind with limit-only headroom", () => {
		const rows = normalizeAwsQuotas("us-east-1", byCode);
		// Two LB codes present (ALB + NLB), CLB absent → 5 rows total.
		expect(rows).toHaveLength(5);
		const byKind = (k: string) => rows.filter((r) => r.quota_kind === k);
		expect(byKind("elastic_ip").map((r) => r.native_id)).toEqual(["L-0263D0A3"]);
		expect(byKind("nat_gateway")[0].quota_limit).toBe(5);
		expect(byKind("security_group")[0].quota_limit).toBe(2500);
		expect(byKind("load_balancer").map((r) => r.native_id).sort()).toEqual([
			"L-53DA6B97",
			"L-69A177A2",
		]);
		for (const r of rows) {
			expect(r.region).toBe("us-east-1");
			expect(r.used).toBeNull();
			expect(r.available).toBeNull();
		}
	});

	it("returns [] when none of our codes are present", () => {
		expect(normalizeAwsQuotas("eu-west-1", new Map())).toEqual([]);
	});

	it("keeps a null limit when the quota value is unknown", () => {
		const m = new Map<string, AwsQuotaValue>([
			["L-0263D0A3", { name: "EIP", value: null }],
		]);
		expect(normalizeAwsQuotas("us-east-1", m)[0].quota_limit).toBeNull();
	});
});
