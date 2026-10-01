// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// recordEnvironmentCost — the job-status route's service-role write of a PLAN's Infracost
// breakdown. Mocked boundary: the service DB records what was inserted; the breakdown parser is
// real, so the test pins the row the promotion cost gate will later read as its baseline.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** Every `.insert(table).values(row)` the code under test made. */
	const inserts: { table: unknown; row: unknown }[] = [];
	const db = {
		/** Records the target table, then the row. */
		insert(table: unknown) {
			return {
				/** Records the inserted row. */
				values(row: unknown): Promise<void> {
					inserts.push({ table, row });
					return Promise.resolve();
				},
			};
		},
	};
	return { db, inserts };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));

import { recordEnvironmentCost } from "@/lib/cost/record-environment-cost";
import { environmentCost } from "@/lib/db/schema";

beforeEach(() => {
	fake.inserts.length = 0;
});

describe("recordEnvironmentCost", () => {
	it("appends one row with the total and the priced resources keyed by address", async () => {
		const result = await recordEnvironmentCost({
			projectId: "p1",
			environmentId: "env-1",
			planJobId: "plan-1",
			costBreakdown: {
				totalMonthlyCost: "142.50",
				projects: [
					{
						breakdown: {
							resources: [
								{ name: "aws_eks_cluster.main", resourceType: "aws_eks_cluster", monthlyCost: "73" },
								{ name: "aws_nat_gateway.a", resourceType: "aws_nat_gateway", monthlyCost: "69.5" },
								{ name: "aws_s3_bucket.logs", resourceType: "aws_s3_bucket", monthlyCost: "0" },
							],
						},
					},
				],
			},
		});

		expect(result).toEqual({ totalMonthly: 142.5 });
		expect(fake.inserts).toHaveLength(1);
		expect(fake.inserts[0].table).toBe(environmentCost);
		expect(fake.inserts[0].row).toEqual({
			project_id: "p1",
			environment_id: "env-1",
			plan_job_id: "plan-1",
			total_monthly: 142.5,
			currency: "USD",
			resources: [
				{ address: "aws_eks_cluster.main", resourceType: "aws_eks_cluster", monthlyCost: 73 },
				{ address: "aws_nat_gateway.a", resourceType: "aws_nat_gateway", monthlyCost: 69.5 },
			],
		});
	});

	it("records an unpriced plan as a zero total with no resources, rather than skipping it", async () => {
		const result = await recordEnvironmentCost({
			projectId: "p1",
			environmentId: "env-1",
			planJobId: "plan-2",
			costBreakdown: {},
		});
		expect(result).toEqual({ totalMonthly: 0 });
		expect(fake.inserts[0].row).toMatchObject({ total_monthly: 0, resources: [] });
	});
});
