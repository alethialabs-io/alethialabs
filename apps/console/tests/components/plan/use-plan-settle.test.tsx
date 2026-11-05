// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — `usePlan` moves its phase when the job list shows its job settled: a failed plan, a failed
// deploy, a finished deploy. That used to be set from effects; it is now set while rendering, and
// the parent's refresh runs once per settled job however often the list re-renders.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Job = { id: string; status: string; error_message: string | null };

const h = vi.hoisted(() => ({
	jobs: [] as Job[],
	tryPlanProject: vi.fn(),
	tryProvisionProject: vi.fn(),
}));

vi.mock("@/lib/query/use-jobs-query", () => ({ useJobsQuery: () => ({ data: h.jobs }) }));
vi.mock("@/hooks/use-job-log-stream", () => ({ useJobLogStream: () => ({ logs: [] }) }));
vi.mock("@/app/server/actions/projects", () => ({
	tryPlanProject: (...args: unknown[]) => h.tryPlanProject(...args),
	tryProvisionProject: (...args: unknown[]) => h.tryProvisionProject(...args),
}));
vi.mock("@/lib/rpc/client", () => ({
	rpcClient: { jobs: { project: vi.fn().mockResolvedValue([]), planResult: vi.fn() } },
}));

import { usePlan } from "@/components/plan/use-plan";

beforeEach(() => {
	h.jobs = [];
	h.tryPlanProject.mockResolvedValue({ ok: true, jobId: "plan-1" });
	h.tryProvisionProject.mockResolvedValue({ ok: true, jobId: "deploy-1" });
});

describe("usePlan — a settled job moves the phase", () => {
	it("a failed plan job fails the plan with its message, refreshing once", async () => {
		const onRefresh = vi.fn();
		const { result, rerender } = renderHook(() => usePlan("p1", onRefresh));
		await act(() => result.current.generatePlan());
		expect(result.current.phase).toBe("generating");

		h.jobs = [{ id: "plan-1", status: "FAILED", error_message: "tofu exploded" }];
		rerender();
		expect(result.current.phase).toBe("failed");
		expect(result.current.error).toBe("tofu exploded");

		rerender();
		rerender();
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("a finished deploy job marks the plan applied, refreshing once", async () => {
		const onRefresh = vi.fn();
		const { result, rerender } = renderHook(() => usePlan("p1", onRefresh));
		await act(() => result.current.generatePlan());
		h.jobs = [{ id: "plan-1", status: "RUNNING", error_message: null }];
		rerender();
		await act(() => result.current.applyPlan());
		expect(result.current.phase).toBe("applying");

		h.jobs = [{ id: "deploy-1", status: "SUCCESS", error_message: null }];
		rerender();
		expect(result.current.phase).toBe("applied");
		rerender();
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("a failed deploy job fails with the default sentence when the job has none", async () => {
		const { result, rerender } = renderHook(() => usePlan("p1"));
		await act(() => result.current.generatePlan());
		await act(() => result.current.applyPlan());

		h.jobs = [{ id: "deploy-1", status: "FAILED", error_message: null }];
		rerender();
		expect(result.current.phase).toBe("failed");
		expect(result.current.error).toBe("Deployment failed");
	});
});
