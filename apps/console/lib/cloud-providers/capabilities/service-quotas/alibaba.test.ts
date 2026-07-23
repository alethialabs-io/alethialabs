// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Alibaba service-quota lane (#981): the pure normalizer over the flattened DescribeAccountAttributes
// items. Alibaba reports the ceiling only (no usage), so used/available are NULL. Only security_group is
// covered here (EIP/NAT/SLB need the Quota Center SDK — documented gap).

import { describe, expect, it } from "vitest";
import {
	type AccountAttribute,
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
