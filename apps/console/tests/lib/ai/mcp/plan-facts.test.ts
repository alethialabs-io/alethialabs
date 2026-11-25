// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What `get_plan_result` adds to the in-app plan result (lib/ai/mcp/plan-facts.ts): the counts of a
// stored plan (a replacement on both sides), the verify receipt's digest only when it is a SHA-256,
// and the cost change against the plan the environment's latest deploy applied. The plan result is
// read first, through the read that authorizes the caller for the job.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/rpc/procedures/jobs", () => ({ readPlanResult: vi.fn() }));
vi.mock("@/lib/approvals/binding", () => ({ appliedState: vi.fn() }));
vi.mock("@/lib/plan/parse-plan", () => ({ parsePlanJSON: vi.fn() }));

import { planCostDelta, planCounts, readPlanFacts } from "@/lib/ai/mcp/plan-facts";
import { appliedState } from "@/lib/approvals/binding";
import { currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { parsePlanJSON } from "@/lib/plan/parse-plan";
import { readPlanResult } from "@/lib/rpc/procedures/jobs";
import { txAnswering } from "./tx-stub";

const ACTOR: Actor = { userId: "user-1", orgId: "org-1", credential: "agent_oauth", credentialRef: "client-1" };

/** Runs the scoped callback against a transaction answering `rowSets`. */
function scopeTo(...rowSets: unknown[][]) {
	const tx = txAnswering(...rowSets);
	vi.mocked(withActorScope).mockImplementation(((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never);
	return tx;
}

const APPLIED = { deployJobId: "d1", planJobId: "plan-0", planSha256: null, createdAt: new Date() };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue(ACTOR);
});

describe("planCounts", () => {
	it("counts a replacement as an add and a destroy", () => {
		vi.mocked(parsePlanJSON).mockReturnValue({ resources: [], counts: { create: 2, update: 1, delete: 1, replace: 1 } } as never);
		expect(planCounts({ resource_changes: [] })).toEqual({ adds: 3, changes: 1, destroys: 2 });
	});

	it("answers nulls for no plan, and for one that does not parse", () => {
		expect(planCounts(undefined)).toEqual({ adds: null, changes: null, destroys: null });
		vi.mocked(parsePlanJSON).mockImplementation(() => {
			throw new Error("not a plan");
		});
		expect(planCounts({})).toEqual({ adds: null, changes: null, destroys: null });
	});
});

describe("planCostDelta", () => {
	it("is the plan's total minus the deployed plan's total, in minor units", async () => {
		scopeTo([{ environment_id: "e1", total_monthly: 120.5, currency: "USD" }], [{ environment_id: "e1", total_monthly: 100.25, currency: "USD" }]);
		vi.mocked(appliedState).mockResolvedValue(APPLIED);
		expect(await planCostDelta(ACTOR, "plan-1")).toEqual({ amount_minor: 2025, currency: "USD" });
	});

	it("is the plan's whole total when nothing was deployed", async () => {
		scopeTo([{ environment_id: "e1", total_monthly: 40, currency: "EUR" }]);
		vi.mocked(appliedState).mockResolvedValue(null);
		expect(await planCostDelta(ACTOR, "plan-1")).toEqual({ amount_minor: 4000, currency: "EUR" });
	});

	it("is null when it cannot be known", async () => {
		scopeTo([]);
		expect(await planCostDelta(ACTOR, "plan-1")).toBeNull();

		scopeTo([{ environment_id: "e1", total_monthly: null, currency: "USD" }]);
		expect(await planCostDelta(ACTOR, "plan-1")).toBeNull();

		scopeTo([{ environment_id: "e1", total_monthly: 10, currency: "USD" }]);
		vi.mocked(appliedState).mockResolvedValue({ ...APPLIED, planJobId: null });
		expect(await planCostDelta(ACTOR, "plan-1")).toBeNull();

		vi.mocked(appliedState).mockResolvedValue(APPLIED);
		scopeTo([{ environment_id: "e1", total_monthly: 10, currency: "USD" }], []);
		expect(await planCostDelta(ACTOR, "plan-1")).toBeNull();

		scopeTo([{ environment_id: "e1", total_monthly: 10, currency: "USD" }], [{ environment_id: "e1", total_monthly: null, currency: "USD" }]);
		expect(await planCostDelta(ACTOR, "plan-1")).toBeNull();

		scopeTo([{ environment_id: "e1", total_monthly: 10, currency: "USD" }], [{ environment_id: "e1", total_monthly: 5, currency: "EUR" }]);
		expect(await planCostDelta(ACTOR, "plan-1")).toBeNull();
	});
});

describe("readPlanFacts", () => {
	it("reads the plan result first, then answers its counts, digest and cost change", async () => {
		const order: string[] = [];
		vi.mocked(readPlanResult).mockImplementation(async () => {
			order.push("result");
			return {
				status: "SUCCESS",
				job_type: "PLAN",
				error_message: null,
				execution_metadata: { plan_result: { resource_changes: [] }, verify_receipt: { receipt: { plan_sha256: "b".repeat(64) } } },
			} as never;
		});
		vi.mocked(withActorScope).mockImplementation((async () => {
			order.push("cost");
			return null;
		}) as never);
		vi.mocked(parsePlanJSON).mockReturnValue({ resources: [], counts: { create: 1, update: 0, delete: 0, replace: 0 } } as never);
		expect(await readPlanFacts("plan-1")).toEqual({
			adds: 1,
			changes: 0,
			destroys: 0,
			plan_sha256: "b".repeat(64),
			monthly_cost_delta: null,
		});
		expect(order).toEqual(["result", "cost"]);
		expect(readPlanResult).toHaveBeenCalledWith("plan-1");
	});

	it("drops a digest that is not a SHA-256, and reads a plan with no metadata", async () => {
		vi.mocked(withActorScope).mockResolvedValue(null as never);
		vi.mocked(readPlanResult).mockResolvedValue({
			status: "SUCCESS",
			job_type: "PLAN",
			error_message: null,
			execution_metadata: { verify_receipt: { receipt: { plan_sha256: "not-a-digest" } } },
		} as never);
		expect(await readPlanFacts("plan-1")).toMatchObject({ plan_sha256: null, adds: null });

		vi.mocked(readPlanResult).mockResolvedValue({ status: "QUEUED", job_type: "PLAN", error_message: null, execution_metadata: null } as never);
		expect(await readPlanFacts("plan-1")).toMatchObject({ plan_sha256: null, adds: null });
	});
});
