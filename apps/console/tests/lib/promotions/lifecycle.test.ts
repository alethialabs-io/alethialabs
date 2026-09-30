// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the service-role promotion LIFECYCLE (lib/promotions/lifecycle.ts).
//
// The boundary is stubbed — the service DB (a scripted query-builder fake), the env-status CAS, the
// job quota, the scaler, the cost baseline, the classification lookup and the approval-slot CAS —
// and the gate engine (lib/promotions/gates.ts) runs for REAL, so each test drives a genuine
// pass / pending_approval / blocked decision and asserts what the orchestrator then WRITES.
//
// The end-to-end proof of the same chain against a real Postgres is BYOC B6.1
// (test/e2e/t2_b6_promotion_run_test.go); this file is the fast, per-PR half.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** Rows each awaited SELECT resolves to, consumed in call order. */
	const selects: unknown[][] = [];
	/** Rows each awaited INSERT … RETURNING resolves to, consumed in call order. */
	const insertReturns: unknown[][] = [];
	/** Every `.values(...)` payload, in order. */
	const inserted: unknown[] = [];
	/** Every `.set(...)` payload, in order. */
	const updated: unknown[] = [];

	/** A drizzle-shaped builder: every step returns itself; awaiting it resolves the scripted rows. */
	class Chain implements PromiseLike<unknown[]> {
		constructor(private readonly kind: "select" | "insert" | "update") {}
		/** Builder step (no-op). */
		select(): this {
			return this;
		}
		/** Builder step (no-op). */
		from(): this {
			return this;
		}
		/** Builder step (no-op). */
		where(): this {
			return this;
		}
		/** Builder step (no-op). */
		limit(): this {
			return this;
		}
		/** Builder step (no-op). */
		orderBy(): this {
			return this;
		}
		/** Builder step (no-op). */
		returning(): this {
			return this;
		}
		/** Records an INSERT payload. */
		values(v: unknown): this {
			inserted.push(v);
			return this;
		}
		/** Records an UPDATE payload. */
		set(v: unknown): this {
			updated.push(v);
			return this;
		}
		/** Resolves the scripted rows for this statement kind. */
		then<A = unknown[], B = never>(
			onFulfilled?: ((rows: unknown[]) => A | PromiseLike<A>) | null,
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
		): PromiseLike<A | B> {
			const rows =
				this.kind === "select"
					? (selects.shift() ?? [])
					: this.kind === "insert"
						? (insertReturns.shift() ?? [])
						: [];
			return Promise.resolve(rows).then(onFulfilled, onRejected);
		}
	}

	const db = {
		select: () => new Chain("select"),
		insert: () => new Chain("insert"),
		update: () => new Chain("update"),
	};

	/** Clears every script and record between tests. */
	function reset(): void {
		selects.length = 0;
		insertReturns.length = 0;
		inserted.length = 0;
		updated.length = 0;
	}

	return { db, selects, insertReturns, inserted, updated, reset };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));
vi.mock("@/lib/db/env-status", () => ({ transitionEnv: vi.fn(async () => true) }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn(async () => undefined) }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/cost/previous-environment-cost", () => ({
	getPreviousEnvironmentCost: vi.fn(async () => null),
}));
vi.mock("@/lib/queries/classification", () => ({ getEnforcingValuesFor: vi.fn(async () => []) }));
vi.mock("@/lib/promotions/approve", () => ({ claimApprovalSlot: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: <T>(row: T): T => row }));

import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getPreviousEnvironmentCost } from "@/lib/cost/previous-environment-cost";
import { transitionEnv } from "@/lib/db/env-status";
import { claimApprovalSlot } from "@/lib/promotions/approve";
import {
	advancePromotionOnPlan,
	applyPromotionApproval,
	failPromotionForJob,
	finalizePromotionOnDeploy,
} from "@/lib/promotions/lifecycle";
import { getEnforcingValuesFor } from "@/lib/queries/classification";
import { notifyScaler } from "@/lib/scaler";

const PROMOTION = {
	id: "promo-1",
	project_id: "proj-1",
	user_id: "user-1",
	org_id: "org-1",
	source_environment_id: "env-dev",
	target_environment_id: "env-stg",
	status: "PENDING_PLAN",
	candidate_hash: "hash-1",
	plan_job_id: "plan-1",
	deploy_job_id: null,
};

const PLAN_JOB = {
	id: "plan-1",
	cloud_identity_id: "ci-1",
	config_snapshot: { project: "p" },
	execution_metadata: null,
	verify_override: null,
};

const SOURCE_ENV = {
	id: "env-dev",
	deployed_config_hash: "hash-1",
	last_deployed_at: new Date("2026-01-01T00:00:00Z"),
};

/** A protection-rules row with every gate off unless overridden. */
function rulesRow(over: Record<string, unknown>): Record<string, unknown> {
	return {
		environment_id: "env-stg",
		require_predecessor: false,
		require_verify_pass: false,
		require_approval: false,
		approvers: null,
		soak_minutes: null,
		cost_delta_threshold: null,
		...over,
	};
}

/**
 * Scripts the SELECTs buildGateContext issues, in order: rules, source env, source drift, plan cost,
 * recorded approvals.
 */
function scriptGateContext(opts: {
	rules?: Record<string, unknown> | null;
	source?: Record<string, unknown> | null;
	drift?: Record<string, unknown> | null;
	planCost?: number | null;
	approvals?: Record<string, unknown>[];
}): void {
	fake.selects.push(
		opts.rules ? [opts.rules] : [],
		opts.source === null ? [] : [opts.source ?? SOURCE_ENV],
		opts.drift ? [opts.drift] : [],
		opts.planCost === undefined || opts.planCost === null ? [] : [{ total_monthly: opts.planCost }],
		opts.approvals ?? [],
	);
}

beforeEach(() => {
	fake.reset();
	vi.clearAllMocks();
	vi.mocked(transitionEnv).mockResolvedValue(true);
	vi.mocked(getEnforcingValuesFor).mockResolvedValue([]);
	vi.mocked(getPreviousEnvironmentCost).mockResolvedValue(null);
});

describe("advancePromotionOnPlan", () => {
	it("is a no-op when the job backs no promotion", async () => {
		fake.selects.push([]);
		await advancePromotionOnPlan("plan-x");
		expect(fake.updated).toEqual([]);
		expect(fake.inserted).toEqual([]);
	});

	it("is a no-op once the promotion has left PENDING_PLAN", async () => {
		fake.selects.push([{ ...PROMOTION, status: "DEPLOYING" }]);
		await advancePromotionOnPlan("plan-1");
		expect(fake.updated).toEqual([]);
	});

	it("is a no-op when the plan job row is gone", async () => {
		fake.selects.push([PROMOTION], []);
		await advancePromotionOnPlan("plan-1");
		expect(fake.updated).toEqual([]);
	});

	it("enqueues the DEPLOY from the plan's frozen snapshot when every gate passes", async () => {
		fake.selects.push([PROMOTION], [PLAN_JOB]);
		scriptGateContext({ drift: { in_sync: true }, planCost: 120 });
		vi.mocked(getPreviousEnvironmentCost).mockResolvedValue(100);
		fake.insertReturns.push([{ id: "deploy-1" }]);

		await advancePromotionOnPlan("plan-1");

		expect(getPreviousEnvironmentCost).toHaveBeenCalledWith("env-stg", "plan-1");
		expect(transitionEnv).toHaveBeenCalledWith(fake.db, "env-stg", "enqueueDeploy", null, {
			orgId: "org-1",
			projectId: "proj-1",
		});
		expect(assertJobQuotaAllowed).toHaveBeenCalledWith("org-1");
		expect(fake.inserted).toEqual([
			expect.objectContaining({
				job_type: "DEPLOY",
				status: "QUEUED",
				plan_job_id: "plan-1",
				environment_id: "env-stg",
				config_snapshot: PLAN_JOB.config_snapshot,
				cloud_identity_id: "ci-1",
			}),
		]);
		expect(fake.updated).toEqual([
			expect.objectContaining({ status: "DEPLOYING", deploy_job_id: "deploy-1" }),
		]);
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("inserts no DEPLOY when the env CAS loses the race", async () => {
		fake.selects.push([PROMOTION], [PLAN_JOB]);
		scriptGateContext({});
		vi.mocked(transitionEnv).mockResolvedValue(false);

		await advancePromotionOnPlan("plan-1");

		expect(fake.inserted).toEqual([]);
		expect(fake.updated).toEqual([]);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("parks for approval and materializes the effective number of slots", async () => {
		const rules = rulesRow({
			require_approval: true,
			approvers: { user_ids: [], role: "admin", min_count: 2 },
		});
		fake.selects.push([PROMOTION], [PLAN_JOB]);
		scriptGateContext({ rules });
		fake.selects.push([]); // no approval slots materialized yet

		await advancePromotionOnPlan("plan-1");

		expect(fake.inserted).toHaveLength(1);
		const slots = fake.inserted[0];
		expect(Array.isArray(slots) ? slots.length : 0).toBe(2);
		expect(slots).toEqual([
			expect.objectContaining({ promotion_id: "promo-1", required_role: "admin" }),
			expect.objectContaining({ promotion_id: "promo-1", required_role: "admin" }),
		]);
		expect(fake.updated).toEqual([expect.objectContaining({ status: "PENDING_APPROVAL" })]);
		expect(transitionEnv).not.toHaveBeenCalled();
	});

	it("does not re-materialize slots that already exist", async () => {
		const rules = rulesRow({ require_approval: true });
		fake.selects.push([PROMOTION], [PLAN_JOB]);
		scriptGateContext({ rules });
		fake.selects.push([{ id: "slot-1" }]);

		await advancePromotionOnPlan("plan-1");

		expect(fake.inserted).toEqual([]);
		expect(fake.updated).toEqual([expect.objectContaining({ status: "PENDING_APPROVAL" })]);
	});

	it("blocks on a failing gate and records which one", async () => {
		const rules = rulesRow({ require_verify_pass: true });
		const planJob = {
			...PLAN_JOB,
			execution_metadata: {
				verify_result: {
					controls: [
						{ id: "c1", status: "fail" },
						{ id: "c2", status: "fail" },
					],
				},
			},
			verify_override: { controls: ["c1"] },
		};
		fake.selects.push([PROMOTION], [planJob]);
		scriptGateContext({ rules });

		await advancePromotionOnPlan("plan-1");

		expect(fake.updated).toEqual([
			expect.objectContaining({
				status: "BLOCKED",
				error_message: "1 unwaived hard control failure(s)",
			}),
		]);
	});

	it("fails the predecessor gate when the source env is missing", async () => {
		const rules = rulesRow({ require_predecessor: true });
		fake.selects.push([{ ...PROMOTION, plan_job_id: null }], [PLAN_JOB]);
		scriptGateContext({ rules, source: null });

		await advancePromotionOnPlan("plan-1");

		expect(getPreviousEnvironmentCost).not.toHaveBeenCalled();
		expect(fake.updated).toEqual([
			expect.objectContaining({
				status: "BLOCKED",
				error_message: "No predecessor environment to validate against",
			}),
		]);
	});
});

describe("finalizePromotionOnDeploy", () => {
	it("is a no-op when the job backs no promotion", async () => {
		fake.selects.push([]);
		await finalizePromotionOnDeploy("deploy-x");
		expect(fake.updated).toEqual([]);
	});

	it("marks the promotion SUCCEEDED", async () => {
		fake.selects.push([{ ...PROMOTION, deploy_job_id: "deploy-1" }]);
		await finalizePromotionOnDeploy("deploy-1");
		expect(fake.updated).toEqual([expect.objectContaining({ status: "SUCCEEDED" })]);
	});
});

describe("failPromotionForJob", () => {
	it("is a no-op when no in-flight promotion is backed by the job", async () => {
		fake.selects.push([{ ...PROMOTION, plan_job_id: "other" }]);
		await failPromotionForJob("plan-1");
		expect(fake.updated).toEqual([]);
	});

	it("marks the promotion FAILED for its deploy job", async () => {
		fake.selects.push([{ ...PROMOTION, deploy_job_id: "deploy-1" }]);
		await failPromotionForJob("deploy-1");
		expect(fake.updated).toEqual([
			expect.objectContaining({ status: "FAILED", error_message: "The promotion's job failed" }),
		]);
	});
});

describe("applyPromotionApproval", () => {
	const AWAITING = { ...PROMOTION, status: "PENDING_APPROVAL" };

	it("refuses a promotion that does not exist", async () => {
		fake.selects.push([]);
		await expect(applyPromotionApproval("promo-x", "user-2")).rejects.toThrow("Promotion not found");
	});

	it("refuses a promotion that is not awaiting approval", async () => {
		fake.selects.push([PROMOTION]);
		await expect(applyPromotionApproval("promo-1", "user-2")).rejects.toThrow(
			"This promotion is not awaiting approval",
		);
		expect(claimApprovalSlot).not.toHaveBeenCalled();
	});

	it("refuses a second approval by the same user", async () => {
		fake.selects.push([AWAITING]);
		vi.mocked(claimApprovalSlot).mockResolvedValue({ outcome: "already_approved" });
		await expect(applyPromotionApproval("promo-1", "user-2")).rejects.toThrow(
			"You have already approved this promotion",
		);
	});

	it("refuses when no pending slot remains", async () => {
		fake.selects.push([AWAITING]);
		vi.mocked(claimApprovalSlot).mockResolvedValue({ outcome: "no_slots" });
		await expect(applyPromotionApproval("promo-1", "user-2")).rejects.toThrow(
			"No pending approval slots remain",
		);
	});

	it("refuses when the promotion has no plan job", async () => {
		fake.selects.push([{ ...AWAITING, plan_job_id: null }]);
		vi.mocked(claimApprovalSlot).mockResolvedValue({ outcome: "claimed", slotId: "slot-1" });
		await expect(applyPromotionApproval("promo-1", "user-2")).rejects.toThrow(
			"Promotion plan job not found",
		);
	});

	it("claims a slot, re-evaluates, and enqueues the DEPLOY once quorum is met", async () => {
		const rules = rulesRow({ require_approval: true });
		fake.selects.push([AWAITING]);
		vi.mocked(claimApprovalSlot).mockResolvedValue({ outcome: "claimed", slotId: "slot-1" });
		fake.selects.push([PLAN_JOB]);
		scriptGateContext({ rules, approvals: [{ status: "approved" }] });
		fake.insertReturns.push([{ id: "deploy-1" }]);

		await applyPromotionApproval("promo-1", "user-2", "lgtm");

		expect(claimApprovalSlot).toHaveBeenCalledWith(fake.db, "promo-1", "user-2", "lgtm");
		expect(fake.updated).toEqual([
			expect.objectContaining({ status: "DEPLOYING", deploy_job_id: "deploy-1" }),
		]);
	});
});
