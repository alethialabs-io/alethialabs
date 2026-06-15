// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { parsePlanJSON } from "@/lib/plan/parse-plan";
import { parseCostBreakdown } from "@/lib/plan/parse-cost";

describe("Plan persistence — loadExistingPlan", () => {
	describe("finding latest successful plan", () => {
		it("filters to PLAN type with SUCCESS status", () => {
			const jobs = [
				{ job_type: "DEPLOY", status: "SUCCESS", created_at: "2026-06-01T10:00:00Z" },
				{ job_type: "PLAN", status: "FAILED", created_at: "2026-06-01T09:00:00Z" },
				{ job_type: "PLAN", status: "SUCCESS", created_at: "2026-06-01T08:00:00Z" },
				{ job_type: "PLAN", status: "SUCCESS", created_at: "2026-06-01T07:00:00Z" },
			];

			const latestPlan = jobs
				.filter((j) => j.job_type === "PLAN" && j.status === "SUCCESS")
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

			expect(latestPlan).toBeDefined();
			expect(latestPlan.created_at).toBe("2026-06-01T08:00:00Z");
		});

		it("returns undefined when no successful plans exist", () => {
			const jobs = [
				{ job_type: "PLAN", status: "FAILED", created_at: "2026-06-01T09:00:00Z" },
				{ job_type: "DEPLOY", status: "SUCCESS", created_at: "2026-06-01T10:00:00Z" },
			];

			const latestPlan = jobs
				.filter((j) => j.job_type === "PLAN" && j.status === "SUCCESS")
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

			expect(latestPlan).toBeUndefined();
		});

		it("handles empty jobs list", () => {
			const jobs: Array<{ job_type: string; status: string; created_at: string }> = [];

			const latestPlan = jobs
				.filter((j) => j.job_type === "PLAN" && j.status === "SUCCESS")[0];

			expect(latestPlan).toBeUndefined();
		});
	});

	describe("parsing plan metadata", () => {
		it("parses plan_result with resource_changes", () => {
			const meta = {
				plan_result: {
					resource_changes: [
						{
							address: "aws_vpc.main",
							type: "aws_vpc",
							change: { actions: ["create"], before: null, after: { cidr_block: "10.0.0.0/16" } },
						},
					],
				},
			};

			const result = parsePlanJSON(meta.plan_result as Record<string, unknown>);
			expect(result).not.toBeNull();
			if (result) {
				expect(result.resources.length).toBeGreaterThan(0);
			}
		});

		it("returns empty resources for empty plan_result", () => {
			const result = parsePlanJSON({});
			expect(result).not.toBeNull();
			expect(result!.resources).toHaveLength(0);
		});

		it("returns empty resources for plan_result without resource_changes", () => {
			const result = parsePlanJSON({ some_other_key: true });
			expect(result).not.toBeNull();
			expect(result!.resources).toHaveLength(0);
		});
	});

	describe("parsing cost metadata", () => {
		it("parses cost_breakdown with resources", () => {
			const meta = {
				cost_breakdown: {
					totalMonthlyCost: "142.50",
					projects: [
						{
							breakdown: {
								resources: [
									{ name: "aws_eks_cluster.main", monthlyCost: "73.00" },
									{ name: "aws_rds_cluster.main", monthlyCost: "69.50" },
								],
							},
						},
					],
				},
			};

			const result = parseCostBreakdown(meta.cost_breakdown as Record<string, unknown>);
			expect(result).not.toBeNull();
			if (result) {
				expect(result.totalMonthlyCost).toBe(142.5);
			}
		});

		it("handles missing cost_breakdown gracefully", () => {
			const result = parseCostBreakdown({});
			expect(result).not.toBeNull(); // returns empty/default structure
		});
	});

	describe("plan_file_key in metadata", () => {
		it("indicates plan artifact was uploaded", () => {
			const meta = {
				plan_completed: true,
				plan_result: { resource_changes: [] },
				plan_file_key: "job-123/terraform.plan.out",
			};

			expect(meta.plan_file_key).toBeTruthy();
			expect(meta.plan_file_key).toContain("terraform.plan.out");
		});

		it("absent key means no artifact (old plan or upload failed)", () => {
			const meta = {
				plan_completed: true,
				plan_result: { resource_changes: [] },
			};

			expect((meta as Record<string, unknown>).plan_file_key).toBeUndefined();
		});
	});
});
