// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6831: the board's server read contract for Deploy. A deploy is offered only for a plan
// `canvas.reviewPlan` calls current, so what is pinned here is each way a plan stops being current
// (no plan, a plan that did not succeed, a design saved since, a run queued since), the three values
// a deploy of the plan carries (job id, design revision, digest), and the deploy state the status
// read derives from the two design fingerprints.
//
// The rules are pure functions and are tested as such. The read is driven over a stubbed database:
// each `select()` answers the next queued result, in the order the read issues them.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted<{ results: unknown[][]; selects: number }>(() => ({ results: [], selects: 0 }));

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
}));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(async () => "env-1"),
}));
vi.mock("@/lib/db", () => {
	/** A chain that resolves to the next queued result; a read past the queue fails the test. */
	const select = () => {
		const index = h.selects++;
		const db: Record<string, unknown> = {};
		Object.assign(db, {
			from: () => db,
			innerJoin: () => db,
			where: () => db,
			orderBy: () => db,
			limit: () => db,
			then: (resolve: (v: unknown) => void, reject: (e: Error) => void) => {
				const own = h.results[index];
				if (own === undefined) reject(new Error(`unexpected select #${index + 1}`));
				else resolve(own);
			},
		});
		return db;
	};
	return { getServiceDb: () => ({ select }), withActorScope: vi.fn(), withScope: vi.fn() };
});
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { type PlanCurrencyFacts, planStaleReason, resolveDeployState } from "@/lib/canvas/component-status";
import { readReviewPlan } from "@/lib/rpc/procedures/canvas";

const DIGEST = "d00afee3a0a1aa46d3814c234df364d0ffee658def91126693e00cea6ab0f0c9";
const QUEUED_AT = new Date("2026-11-17T10:00:00.000Z");

/** A PLAN job row as the read selects it. */
function planRow(over: { status?: string; metadata?: unknown } = {}) {
	return {
		id: "plan-1",
		status: over.status ?? "SUCCESS",
		created_at: QUEUED_AT,
		metadata:
			"metadata" in over
				? over.metadata
				: {
						plan_result: {
							resource_changes: [
								{ address: "aws_vpc.this", type: "aws_vpc", name: "this", change: { actions: ["create"] } },
								{ address: "aws_db_instance.a", type: "aws_db_instance", name: "a", change: { actions: ["update"] } },
								{ address: "aws_sqs_queue.q", type: "aws_sqs_queue", name: "q", change: { actions: ["delete"] } },
							],
						},
						verify_receipt: { receipt: { plan_sha256: DIGEST } },
					},
	};
}

/**
 * Queues the read's selects in the order it issues them: the environment guard, the latest plan,
 * the saved revision, then (only with a plan) the plan's revision, a later run and the plan's cost.
 */
function queue(input: {
	environment?: unknown[];
	plan?: unknown;
	savedRevision?: number | null;
	planRevision?: number | null;
	laterRun?: boolean;
	cost?: { total_monthly: number | null; currency: string } | null;
}) {
	const revision = (id: number | null | undefined, fallback: number) =>
		id === null ? [] : [{ id: id ?? fallback }];
	h.results = [
		input.environment ?? [{ id: "env-1" }],
		input.plan ? [input.plan] : [],
		revision(input.savedRevision, 7),
	];
	if (!input.plan) return;
	h.results.push(
		revision(input.planRevision, 7),
		input.laterRun ? [{ id: "deploy-1" }] : [],
		input.cost === null ? [] : [input.cost ?? { total_monthly: 212.4, currency: "EUR" }],
	);
}

beforeEach(() => {
	h.results = [];
	h.selects = 0;
});

describe("planStaleReason — the staleness rule", () => {
	const current: PlanCurrencyFacts = { status: "SUCCESS", planRevision: "7", savedRevision: "7", runSincePlan: false };

	it("a successful plan of the saved design, with nothing run since, is current", () => {
		expect(planStaleReason(current)).toBeNull();
	});

	it("no plan job is never current", () => {
		expect(planStaleReason({ ...current, status: null, planRevision: null })).toBe("no-plan");
	});

	it.each(["QUEUED", "CLAIMED", "PROCESSING", "FAILED", "CANCELLED"] as const)(
		"a %s plan is not current, even of the saved design",
		(status) => {
			expect(planStaleReason({ ...current, status })).toBe("plan-not-succeeded");
		},
	);

	it("a design saved after the plan was queued makes it stale", () => {
		expect(planStaleReason({ ...current, savedRevision: "8" })).toBe("design-changed");
	});

	it("revisions are compared as written, not as numbers", () => {
		expect(planStaleReason({ ...current, planRevision: "07" })).toBe("design-changed");
	});

	it("a plan whose revision is not known is stale, never current", () => {
		expect(planStaleReason({ ...current, planRevision: null })).toBe("design-changed");
	});

	it("a build, deploy or destroy queued after the plan makes it stale", () => {
		expect(planStaleReason({ ...current, runSincePlan: true })).toBe("run-since-plan");
	});

	it("names the design change first when the design changed and a run was queued", () => {
		expect(planStaleReason({ ...current, savedRevision: "8", runSincePlan: true })).toBe("design-changed");
	});
});

describe("resolveDeployState", () => {
	it("an environment with no deployed fingerprint was never deployed, whatever the design", () => {
		expect(resolveDeployState(null, "abc")).toBe("never");
		expect(resolveDeployState(null, null)).toBe("never");
		expect(resolveDeployState("", "abc")).toBe("never");
	});

	it("a saved design that differs from the deployed one is ahead", () => {
		expect(resolveDeployState("abc", "abd")).toBe("ahead");
	});

	it("a saved design equal to the deployed one is in sync", () => {
		expect(resolveDeployState("abc", "abc")).toBe("in-sync");
	});

	it("a deployed environment whose design could not be read is in sync, not ahead", () => {
		expect(resolveDeployState("abc", null)).toBe("in-sync");
	});
});

describe("readReviewPlan (canvas.reviewPlan)", () => {
	it("answers the current plan with the three values a deploy of it carries", async () => {
		queue({ plan: planRow() });
		expect(await readReviewPlan("p1", null)).toEqual({
			environmentId: "env-1",
			planJobId: "plan-1",
			status: "SUCCESS",
			createdAt: QUEUED_AT.toISOString(),
			summary: { create: 1, update: 1, delete: 1, replace: 0 },
			cost: { totalMonthly: 212.4, currency: "EUR" },
			designRevision: "7",
			savedRevision: "7",
			digest: DIGEST,
			current: true,
			staleReason: null,
		});
		// Guard, plan, saved revision, plan revision, later run, cost: nothing else is read.
		expect(h.selects).toBe(6);
	});

	it("an environment with no plan job has nothing to deploy, and reads only what that needs", async () => {
		queue({});
		expect(await readReviewPlan("p1", null)).toEqual({
			environmentId: "env-1",
			planJobId: null,
			status: null,
			createdAt: null,
			summary: null,
			cost: null,
			designRevision: null,
			savedRevision: "7",
			digest: null,
			current: false,
			staleReason: "no-plan",
		});
		expect(h.selects).toBe(3);
	});

	it("a design saved after the plan was queued makes the plan stale, and both revisions are answered", async () => {
		queue({ plan: planRow(), savedRevision: 9, planRevision: 7 });
		expect(await readReviewPlan("p1", null)).toMatchObject({
			planJobId: "plan-1",
			designRevision: "7",
			savedRevision: "9",
			current: false,
			staleReason: "design-changed",
		});
	});

	it("a project with no design-write record reads revision 0 on both sides, so its plan is current", async () => {
		queue({ plan: planRow(), savedRevision: null, planRevision: null });
		expect(await readReviewPlan("p1", null)).toMatchObject({
			designRevision: "0",
			savedRevision: "0",
			current: true,
		});
	});

	it("a run queued after the plan makes it stale", async () => {
		queue({ plan: planRow(), laterRun: true });
		expect(await readReviewPlan("p1", null)).toMatchObject({ current: false, staleReason: "run-since-plan" });
	});

	it("a failed plan of the saved design is not current", async () => {
		queue({ plan: planRow({ status: "FAILED", metadata: null }), cost: null });
		expect(await readReviewPlan("p1", null)).toMatchObject({
			status: "FAILED",
			summary: null,
			cost: null,
			digest: null,
			current: false,
			staleReason: "plan-not-succeeded",
		});
	});

	it("a receipt value that is not a SHA-256 is no digest", async () => {
		for (const plan_sha256 of ["abc", DIGEST.toUpperCase(), `${DIGEST}0`, ""]) {
			h.selects = 0;
			queue({ plan: planRow({ metadata: { verify_receipt: { receipt: { plan_sha256 } } } }) });
			expect((await readReviewPlan("p1", null)).digest).toBeNull();
		}
	});

	it("a plan with no receipt has no digest and stays current: the digest is not part of the rule", async () => {
		queue({ plan: planRow({ metadata: { plan_result: { resource_changes: [] } } }) });
		expect(await readReviewPlan("p1", null)).toMatchObject({
			digest: null,
			summary: { create: 0, update: 0, delete: 0, replace: 0 },
			current: true,
		});
	});

	it("a plan that was never priced has no cost", async () => {
		queue({ plan: planRow(), cost: null });
		expect((await readReviewPlan("p1", null)).cost).toBeNull();
	});

	it("refuses an environment outside the actor's org as NOT_FOUND before any plan is read", async () => {
		queue({ environment: [] });
		await expect(readReviewPlan("p-foreign", null)).rejects.toMatchObject({
			name: "ActionRefusal",
			kind: "not-found",
		});
		expect(h.selects).toBe(1);
	});
});
