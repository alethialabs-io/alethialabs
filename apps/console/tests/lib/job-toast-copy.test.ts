// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	NOTIFY_JOB_TYPES,
	jobPhase,
	jobToastContent,
} from "@/lib/jobs/toast-copy";
import { makeJob } from "../fixtures/jobs";

describe("jobPhase", () => {
	it("maps in-flight statuses to active", () => {
		expect(jobPhase("QUEUED")).toBe("active");
		expect(jobPhase("CLAIMED")).toBe("active");
		expect(jobPhase("PROCESSING")).toBe("active");
	});

	it("maps terminal statuses to their phase", () => {
		expect(jobPhase("SUCCESS")).toBe("success");
		expect(jobPhase("FAILED")).toBe("failed");
		expect(jobPhase("CANCELLED")).toBe("cancelled");
	});
});

describe("NOTIFY_JOB_TYPES", () => {
	it("includes the six user-initiated job types", () => {
		for (const t of [
			"DEPLOY",
			"DESTROY",
			"PLAN",
			"DEPLOY_RUNNER",
			"UPDATE_RUNNER",
			"DESTROY_RUNNER",
		] as const) {
			expect(NOTIFY_JOB_TYPES.has(t)).toBe(true);
		}
	});

	it("excludes internal/background job types", () => {
		for (const t of ["ANALYZE_REPO", "DETECT_DRIFT"] as const) {
			expect(NOTIFY_JOB_TYPES.has(t)).toBe(false);
		}
	});
});

describe("jobToastContent", () => {
	it("uses a gerund title and project · environment description for active", () => {
		const { title, description } = jobToastContent(
			makeJob({ job_type: "DEPLOY" }),
			"active",
		);
		expect(title).toBe("Deploying…");
		expect(description).toBe("web · production");
	});

	it("uses past-tense titles for terminal phases", () => {
		expect(jobToastContent(makeJob(), "success").title).toBe("Deploy complete");
		expect(jobToastContent(makeJob(), "failed").title).toBe("Deploy failed");
		expect(jobToastContent(makeJob(), "cancelled").title).toBe(
			"Deploy cancelled",
		);
	});

	it("falls back to a single scope segment when only one is present", () => {
		const { description } = jobToastContent(
			makeJob({ project_name: "web", environment_name: null }),
			"active",
		);
		expect(description).toBe("web");
	});

	it("leaves the description undefined when neither scope segment exists", () => {
		const { description } = jobToastContent(
			makeJob({ project_name: null, environment_name: null }),
			"active",
		);
		expect(description).toBeUndefined();
	});

	it("surfaces a truncated error_message on the failed toast", () => {
		const long = "x".repeat(300);
		const { description } = jobToastContent(
			makeJob({ error_message: long }),
			"failed",
		);
		expect(description).toBe("x".repeat(140));
	});

	it("uses type-specific gerunds for runner jobs", () => {
		expect(jobToastContent(makeJob({ job_type: "UPDATE_RUNNER" }), "active").title).toBe(
			"Updating runner…",
		);
		expect(jobToastContent(makeJob({ job_type: "PLAN" }), "active").title).toBe(
			"Planning…",
		);
	});
});
