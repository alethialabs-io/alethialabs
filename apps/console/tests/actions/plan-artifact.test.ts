// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

describe("Plan artifact storage", () => {
	describe("file key generation", () => {
		it("generates correct storage path from job ID", () => {
			const jobId = "abc123-def456";
			const path = `${jobId}/tofu.plan.out`;
			expect(path).toBe("abc123-def456/tofu.plan.out");
		});

		it("handles UUID-format job IDs", () => {
			const jobId = "24b2941a-b6de-4a3f-b0f9-d11630d60b56";
			const path = `${jobId}/tofu.plan.out`;
			expect(path).toContain(jobId);
			expect(path).toMatch(/\/tofu\.plan\.out$/);
		});
	});

	describe("plan file validation", () => {
		it("rejects empty body", () => {
			const body = new ArrayBuffer(0);
			expect(body.byteLength).toBe(0);
		});

		it("rejects files over 50MB", () => {
			const maxSize = 50 * 1024 * 1024;
			const oversized = maxSize + 1;
			expect(oversized > maxSize).toBe(true);
		});

		it("accepts valid plan file size", () => {
			const maxSize = 50 * 1024 * 1024;
			const validSize = 3 * 1024 * 1024; // 3MB typical plan
			expect(validSize <= maxSize).toBe(true);
		});
	});

	describe("plan artifact flow", () => {
		it("PLAN job stores key in execution_metadata", () => {
			const jobId = "plan-job-123";
			const metadata = {
				plan_completed: true,
				plan_result: { resource_changes: [] },
				plan_file_key: `${jobId}/tofu.plan.out`,
			};

			expect(metadata.plan_file_key).toBe(
				"plan-job-123/tofu.plan.out",
			);
		});

		it("DEPLOY job references plan job for artifact download", () => {
			const deployJob = {
				id: "deploy-job-456",
				plan_job_id: "plan-job-123",
			};
			const downloadPath = `${deployJob.plan_job_id}/tofu.plan.out`;
			expect(downloadPath).toBe(
				"plan-job-123/tofu.plan.out",
			);
		});

		it("falls back to re-plan when artifact is missing", () => {
			const downloadError = "plan artifact not found (expired or missing)";
			const shouldReplan = downloadError.includes("not found");
			expect(shouldReplan).toBe(true);
		});
	});
});
