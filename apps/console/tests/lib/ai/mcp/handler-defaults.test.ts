// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The default dependencies of the MCP write tools (lib/ai/mcp/handlers.ts): each one is the ordinary
// server action or read every other surface uses, called with the approval id the queue gate consumes
// and no other authority. The server actions are stood in; what is asserted is the wiring.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({ planProject: vi.fn(), provisionProject: vi.fn(), destroyProject: vi.fn() }));
vi.mock("@/app/server/actions/jobs", () => ({ cancelJob: vi.fn() }));
vi.mock("@/app/server/actions/scanner", () => ({ scanRepo: vi.fn() }));
vi.mock("@/lib/ai/mcp/feedback", () => ({ sendAgentFeedback: vi.fn() }));
vi.mock("@/lib/rpc/procedures/jobs", () => ({ readJobStatus: vi.fn() }));
vi.mock("@/lib/ai/mcp/approval-store", () => ({
	findOwnApproval: vi.fn(),
	requestOwnApproval: vi.fn(),
	readOwnOrgApproval: vi.fn(),
	destroyPlanFor: vi.fn(),
}));
vi.mock("@/lib/ai/mcp/job-logs", () => ({ readJobLogPage: vi.fn() }));

import { cancelJob } from "@/app/server/actions/jobs";
import { destroyProject, planProject, provisionProject } from "@/app/server/actions/projects";
import { scanRepo } from "@/app/server/actions/scanner";
import { sendAgentFeedback } from "@/lib/ai/mcp/feedback";
import { defaultHandlerDeps } from "@/lib/ai/mcp/handlers";
import { approvePathForOrg } from "@/lib/approvals/http";

describe("defaultHandlerDeps", () => {
	it("queues a plan through planProject with the MCP idempotency key", async () => {
		vi.mocked(planProject).mockResolvedValue({ jobId: "job-plan" });
		await defaultHandlerDeps.queuePlan({ projectId: "p1", environmentId: "e1", key: "mcp:k", destroy: false });
		expect(planProject).toHaveBeenCalledWith("p1", null, "e1", "mcp:k", { destroy: false });
	});

	it("queues a destroy plan through planProject's destroy option", async () => {
		vi.mocked(planProject).mockResolvedValue({ jobId: "job-dplan" });
		await defaultHandlerDeps.queuePlan({ projectId: "p1", environmentId: "e1", key: "mcp:destroy:k", destroy: true });
		expect(planProject).toHaveBeenCalledWith("p1", null, "e1", "mcp:destroy:k", { destroy: true });
	});

	it("queues a deploy through provisionProject with the plan and the approval for the gate to consume", async () => {
		vi.mocked(provisionProject).mockResolvedValue({ jobId: "job-deploy" });
		const queued = await defaultHandlerDeps.queueDeploy({
			projectId: "p1",
			environmentId: "e1",
			planJobId: "plan-1",
			approvalId: "apr-1",
		});
		expect(queued).toEqual({ jobId: "job-deploy" });
		expect(provisionProject).toHaveBeenCalledWith("p1", "plan-1", null, "e1", null, "apr-1");
	});

	it("queues a destroy through destroyProject with the approval for the gate to consume", async () => {
		vi.mocked(destroyProject).mockResolvedValue({ jobId: "job-destroy", jobs: [] });
		const queued = await defaultHandlerDeps.queueDestroy({ projectId: "p1", environmentId: "e1", approvalId: "apr-2" });
		expect(queued).toEqual({ jobId: "job-destroy" });
		expect(destroyProject).toHaveBeenCalledWith("p1", "e1", null, { approvalId: "apr-2" });
	});

	it("cancels through the cancelJob server action", async () => {
		vi.mocked(cancelJob).mockResolvedValue({ ok: true, data: null });
		await defaultHandlerDeps.cancelJob("job-1");
		expect(cancelJob).toHaveBeenCalledWith({ jobId: "job-1" });
	});

	it("queues a scan through scanRepo with the MCP idempotency key", async () => {
		vi.mocked(scanRepo).mockResolvedValue({ jobId: "job-scan" });
		expect(await defaultHandlerDeps.queueScan({ repo: "https://github.com/acme/api", key: "mcp:k" })).toEqual({ jobId: "job-scan" });
		expect(scanRepo).toHaveBeenCalledWith("https://github.com/acme/api", { idempotencyKey: "mcp:k" });
	});

	it("links an approval by the path the approvals API answers as approve_path", () => {
		expect(defaultHandlerDeps.approvePath).toBe(approvePathForOrg);
	});

	it("sends feedback through the agent feedback sink", () => {
		expect(defaultHandlerDeps.sendFeedback).toBe(sendAgentFeedback);
	});

	it("sleeps on a timer and reads the wall clock", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
			expect(defaultHandlerDeps.now()).toBe(Date.parse("2026-11-24T12:00:00.000Z"));
			let woke = false;
			const sleeping = defaultHandlerDeps.sleep(2_000).then(() => {
				woke = true;
			});
			await vi.advanceTimersByTimeAsync(1_999);
			expect(woke).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await sleeping;
			expect(woke).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
