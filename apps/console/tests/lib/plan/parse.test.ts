// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The plan/cost parsers turn external tool JSON (OpenTofu `plan -json` / Infracost
// breakdown) into the typed shapes the Plan tab renders. They're now zod-validated: costs
// coerce from Infracost's decimal strings, and malformed/partial payloads degrade to empty
// instead of throwing. These pin both the happy path and the leniency contract.

import { describe, expect, it } from "vitest";
import { parseCostBreakdown } from "@/lib/plan/parse-cost";
import { parsePlanJSON } from "@/lib/plan/parse-plan";

describe("parsePlanJSON", () => {
	it("resolves actions, counts, and resource metadata", () => {
		const result = parsePlanJSON({
			resource_changes: [
				{
					type: "aws_eks_cluster",
					name: "main",
					address: "aws_eks_cluster.main",
					change: { actions: ["create"], after: { version: "1.30" } },
				},
				{
					type: "aws_rds_cluster",
					name: "db",
					address: "aws_rds_cluster.db",
					change: { actions: ["create", "delete"] },
				},
				{
					type: "aws_s3_bucket",
					name: "logs",
					address: "aws_s3_bucket.logs",
					change: { actions: ["update"] },
				},
				// no-op is dropped
				{ type: "aws_vpc", name: "v", address: "aws_vpc.v", change: { actions: ["no-op"] } },
			],
		});
		expect(result.counts).toEqual({ create: 1, update: 1, delete: 0, replace: 1 });
		expect(result.resources).toHaveLength(3);
		const cluster = result.resources.find((r) => r.type === "aws_eks_cluster");
		expect(cluster?.action).toBe("create");
		expect(cluster?.category).toBe("Compute");
		expect(cluster?.properties.version).toEqual({ value: "1.30", computed: false });
	});

	it("marks after_unknown attributes as computed and skips nested objects", () => {
		const result = parsePlanJSON({
			resource_changes: [
				{
					type: "aws_vpc",
					name: "v",
					address: "aws_vpc.v",
					change: {
						actions: ["create"],
						after: { cidr: "10.0.0.0/16", tags: { a: 1 }, id: "skip-me" },
						after_unknown: { cidr: true },
					},
				},
			],
		});
		const props = result.resources[0].properties;
		expect(props.cidr).toEqual({ value: "10.0.0.0/16", computed: true });
		expect(props.tags).toBeUndefined(); // nested object skipped
		expect(props.id).toBeUndefined(); // SKIP_KEYS
	});

	it("falls back to an unknown-resource label for unmapped types", () => {
		const result = parsePlanJSON({
			resource_changes: [
				{ type: "aws_lambda_function", name: "fn", address: "a", change: { actions: ["create"] } },
			],
		});
		expect(result.resources[0].category).toBe("Other");
		expect(result.resources[0].displayName).toBe("lambda function");
	});

	it("degrades to no changes on empty or malformed input (never throws)", () => {
		expect(parsePlanJSON({}).resources).toHaveLength(0);
		expect(parsePlanJSON({ some_other_key: true }).resources).toHaveLength(0);
		expect(parsePlanJSON({ resource_changes: "not-an-array" }).resources).toHaveLength(0);
		expect(parsePlanJSON({ resource_changes: [42, null] }).counts).toEqual({
			create: 0,
			update: 0,
			delete: 0,
			replace: 0,
		});
	});
});

describe("parseCostBreakdown", () => {
	const breakdown = {
		totalMonthlyCost: "142.50",
		totalHourlyCost: "0.195",
		projects: [
			{
				breakdown: {
					resources: [
						{
							name: "aws_eks_cluster.main",
							resourceType: "aws_eks_cluster",
							monthlyCost: "73.00",
							hourlyCost: "0.10",
							subresources: [{ name: "control_plane", monthlyCost: "73.00" }],
						},
						{
							name: "aws_rds_cluster.db",
							resourceType: "aws_rds_cluster",
							monthlyCost: "69.50",
							hourlyCost: "0.095",
						},
						// free resource — dropped
						{ name: "aws_vpc.main", resourceType: "aws_vpc", monthlyCost: "0" },
					],
				},
			},
		],
	};

	it("coerces string costs and ranks priced resources", () => {
		const result = parseCostBreakdown(breakdown);
		expect(result.totalMonthlyCost).toBe(142.5);
		expect(result.totalHourlyCost).toBe(0.195);
		expect(result.resources).toHaveLength(2);
		// sorted by monthly cost desc
		expect(result.resources[0].name).toBe("aws_eks_cluster.main");
		expect(result.resources[0].monthlyCost).toBe(73);
		expect(result.resources[0].subResources).toEqual([
			{ name: "control_plane", monthlyCost: 73 },
		]);
	});

	it("defaults absent totals to 0 and degrades to empty on malformed input", () => {
		const empty = parseCostBreakdown({});
		expect(empty.totalMonthlyCost).toBe(0);
		expect(empty.resources).toHaveLength(0);
		expect(parseCostBreakdown({ projects: "nope" }).resources).toHaveLength(0);
		// unparseable total → null, not NaN
		expect(parseCostBreakdown({ totalMonthlyCost: "n/a" }).totalMonthlyCost).toBeNull();
	});
});
