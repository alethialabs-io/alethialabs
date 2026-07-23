// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Alibaba service-quota lane (#981, #1229): the pure normalizers. `normalizeAlibabaSecurityGroups` maps the
// flattened DescribeAccountAttributes items (ceiling only → used/available NULL). `normalizeAlibabaQuotaCenter`
// maps the flattened Quota Center quotas for EIP / NAT-gateway / load-balancer, which DO carry usage → real
// limit/used/available (#1229 closes the #981 gap).

import { describe, expect, it } from "vitest";
import {
	type AccountAttribute,
	type QuotaCenterItem,
	normalizeAlibabaQuotaCenter,
	normalizeAlibabaSecurityGroups,
} from "@/lib/cloud-providers/capabilities/service-quotas/alibaba";

describe("normalizeAlibabaSecurityGroups", () => {
	const attrs: AccountAttribute[] = [
		{ attributeName: "max-security-groups", values: ["100"] },
		{ attributeName: "max-dedicated-hosts", values: ["10"] }, // unrelated → ignored
	];

	it("maps max-security-groups to a security_group ceiling (limit only)", () => {
		const rows = normalizeAlibabaSecurityGroups("cn-hangzhou", attrs);
		expect(rows).toHaveLength(1);
		expect(rows[0].quota_kind).toBe("security_group");
		expect(rows[0].native_id).toBe("max-security-groups");
		expect(rows[0].region).toBe("cn-hangzhou");
		expect(rows[0].quota_limit).toBe(100);
		expect(rows[0].used).toBeNull();
		expect(rows[0].available).toBeNull();
	});

	it("returns [] when the attribute is absent", () => {
		expect(normalizeAlibabaSecurityGroups("cn-hangzhou", [])).toEqual([]);
	});

	it("keeps a null limit when the value is non-numeric", () => {
		const rows = normalizeAlibabaSecurityGroups("cn-hangzhou", [
			{ attributeName: "max-security-groups", values: ["n/a"] },
		]);
		expect(rows[0].quota_limit).toBeNull();
	});
});

describe("normalizeAlibabaQuotaCenter", () => {
	// Recorded ListProductQuotas quotas (trimmed) across the three networking products.
	const items: QuotaCenterItem[] = [
		{
			productCode: "eip",
			quotaActionCode: "eip_whitelist/eip_number",
			quotaName: "Maximum number of EIPs",
			totalQuota: 20,
			totalUsage: 5,
		},
		{
			productCode: "vpc",
			quotaActionCode: "vpc_quota_ngw_num",
			quotaName: "NAT gateways",
			totalQuota: 10,
			totalUsage: 2,
		},
		{
			productCode: "slb",
			quotaActionCode: "slb_quota_instances_num",
			quotaName: "CLB instances",
			totalQuota: 60,
			totalUsage: 60,
		},
		// A non-networking quota for the same product → ignored.
		{
			productCode: "eip",
			quotaActionCode: "eip_whitelist/bandwidth",
			quotaName: "Bandwidth",
			totalQuota: 5000,
			totalUsage: 100,
		},
	];

	it("maps each kind and computes available = limit − used", () => {
		const rows = normalizeAlibabaQuotaCenter("cn-hangzhou", items);
		expect(rows.map((r) => r.quota_kind).sort()).toEqual([
			"elastic_ip",
			"load_balancer",
			"nat_gateway",
		]);
		const eip = rows.find((r) => r.quota_kind === "elastic_ip");
		expect(eip).toMatchObject({
			region: "cn-hangzhou",
			native_id: "eip_whitelist/eip_number",
			name: "Maximum number of EIPs",
			quota_limit: 20,
			used: 5,
			available: 15,
		});
		const lb = rows.find((r) => r.quota_kind === "load_balancer");
		expect(lb?.available).toBe(0); // fully consumed (60/60)
	});

	it("keeps available null when usage is not reported", () => {
		const rows = normalizeAlibabaQuotaCenter("cn-beijing", [
			{
				productCode: "vpc",
				quotaActionCode: "vpc_quota_ngw_num",
				quotaName: "NAT gateways",
				totalQuota: 10,
				totalUsage: null,
			},
		]);
		expect(rows[0]).toMatchObject({
			quota_kind: "nat_gateway",
			quota_limit: 10,
			used: null,
			available: null,
		});
	});

	it("emits nothing when no action code matches a spec", () => {
		const rows = normalizeAlibabaQuotaCenter("cn-hangzhou", [
			{
				productCode: "eip",
				quotaActionCode: "eip_whitelist/unknown_metric",
				quotaName: "Unknown",
				totalQuota: 1,
				totalUsage: 0,
			},
		]);
		expect(rows).toEqual([]);
	});
});
