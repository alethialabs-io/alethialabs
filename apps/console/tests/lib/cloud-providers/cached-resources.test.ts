// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces the deleted tests/actions/aws-resources.test.ts, which re-implemented the defaulting
// inline. Drives the REAL normalizeCachedResources extracted from getCachedAwsResources.

import { describe, expect, it } from "vitest";
import { normalizeCachedResources } from "@/lib/cloud-providers/cached-resources";

describe("normalizeCachedResources", () => {
	it("passes through a fully-populated payload", () => {
		const res = normalizeCachedResources({
			regions: ["us-east-1", "eu-west-1"],
			vpcs: {
				"us-east-1": [{ ID: "vpc-1", CIDR: "10.0.0.0/16", Name: "prod", IsDefault: false }],
			},
			subnets: {},
			hosted_zones: [{ ID: "Z123", Name: "example.com", RecordCount: 10, IsPrivate: false }],
		});
		expect(res.regions).toHaveLength(2);
		expect(res.vpcs["us-east-1"]).toHaveLength(1);
		expect(res.hosted_zones[0].Name).toBe("example.com");
	});

	it("fills empty defaults for missing collections", () => {
		const res = normalizeCachedResources({ regions: ["us-east-1"] });
		expect(res.regions).toEqual(["us-east-1"]);
		expect(res.vpcs).toEqual({});
		expect(res.subnets).toEqual({});
		expect(res.hosted_zones).toEqual([]);
	});

	it("returns all-empty for null/empty input", () => {
		for (const input of [null, undefined, {}]) {
			const res = normalizeCachedResources(input);
			expect(res).toEqual({ regions: [], vpcs: {}, subnets: {}, hosted_zones: [] });
		}
	});

	it("preserves optional iam_users when present", () => {
		const res = normalizeCachedResources({
			iam_users: [{ username: "svc", arn: "arn:aws:iam::1:user/svc", path: "/" }],
		});
		expect(res.iam_users).toHaveLength(1);
	});
});
