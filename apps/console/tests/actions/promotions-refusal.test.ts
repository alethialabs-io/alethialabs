// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5454 — `promoteEnvironment` RETURNS the refusals a person in the promote dialog can act on.
//
// Every one used to be THROWN out of a `"use server"` export, and a production build replaces a
// thrown message with a digest — including the deploy-time gates the PLAN runs, because the action
// called the throwing `planProject` inside itself. Each case asserts the refusal RESOLVES as
// `{ ok: false, error }`; against origin/dev every one fails, because the action rejects.
//
// The plan-refusal case pins the second half of the defect: the refusal arrived AFTER the
// promotion row and the target's new design were both written, so the promotion sat PENDING_PLAN
// with no plan job (holding the target's one-in-flight slot) and the target already carried the
// source's design — a retry found "no structural changes". Now the promotion is marked FAILED with
// the reason and the target's previous design is written back.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ orgId: "org-1", userId: "u1" })),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/lib/promotions/lifecycle", () => ({
	applyPromotionApproval: vi.fn(),
	IN_FLIGHT: ["PENDING_PLAN", "PENDING_APPROVAL", "APPROVED", "DEPLOYING"],
}));
vi.mock("@/lib/promotions/diff", () => ({
	diffDesigns: vi.fn(() => ({ changes: [{ op: "CREATE" }], summary: ["+1"] })),
	diffIsEmpty: vi.fn(() => false),
	mergeChangeset: vi.fn(() => ({ design: "merged" })),
	structuralHash: vi.fn(() => "hash-1"),
}));
// `planProject` is the throwing twin of `tryPlanProject`, exactly as in projects.ts: the same
// answer, with a refusal THROWN. It is here so that, run against the pre-#5454 action (which called
// `planProject`), the plan-refusal case reaches its assertion rather than a missing-mock error.
const plan = vi.hoisted(() => ({
	tryPlanProject: vi.fn<
		(...a: unknown[]) => Promise<{ ok: true; jobId: string } | { ok: false; error: string }>
	>(),
}));
vi.mock("@/app/server/actions/projects", () => ({
	getProjectAsFormData: vi.fn(async (_p: string, envId: string) => ({
		formData: { design: envId },
		provider: "aws",
	})),
	reconcileEnvironmentComponents: vi.fn(async () => ({ success: true })),
	tryPlanProject: plan.tryPlanProject,
	planProject: vi.fn(async (...a: unknown[]) => {
		const r = await plan.tryPlanProject(...a);
		if (!r.ok) throw new Error(r.error);
		return { jobId: r.jobId };
	}),
}));

import { promoteEnvironment } from "@/app/server/actions/promotions";
import {
	reconcileEnvironmentComponents,
	tryPlanProject,
} from "@/app/server/actions/projects";
import { withActorScope } from "@/lib/db";
import { diffIsEmpty } from "@/lib/promotions/diff";

interface EnvRow {
	id: string;
	name: string;
	stage: "development" | "staging" | "production";
	status: string;
}

const DEV: EnvRow = { id: "env-dev", name: "development", stage: "development", status: "ACTIVE" };
const PROD: EnvRow = { id: "env-prod", name: "production", stage: "production", status: "ACTIVE" };

/** Every `.set(...)` the action issued on the promotion row, in order. */
let updates: Record<string, unknown>[] = [];
/** What the promotion insert does: answer with a row, or fail as the unique index would. */
let insertFails: Error | null = null;

/** An actor-scoped tx: a select that answers `envs`, the promotion insert, and recorded updates. */
function mockScope(envs: EnvRow[]) {
	const tx = {
		select: () => ({
			from: () => ({ where: async () => envs }),
		}),
		insert: () => ({
			values: () => ({
				returning: async () => {
					if (insertFails) throw insertFails;
					return [{ id: "promo-1" }];
				},
			}),
		}),
		update: () => ({
			set: (v: Record<string, unknown>) => {
				updates.push(v);
				return { where: async () => undefined };
			},
		}),
	};
	vi.mocked(withActorScope).mockImplementation(
		async (_actor: unknown, fn: (t: never) => unknown) => fn(tx as never),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	updates = [];
	insertFails = null;
	vi.mocked(diffIsEmpty).mockReturnValue(false);
	vi.mocked(tryPlanProject).mockResolvedValue({ ok: true, jobId: "job-1" });
	mockScope([DEV, PROD]);
});

describe("promoteEnvironment — a refusal is a value", () => {
	it("refuses a promotion to a lower stage", async () => {
		await expect(promoteEnvironment("p1", "env-prod", "env-dev")).resolves.toEqual({
			ok: false,
			error: "A promotion can only target an equal or higher stage.",
		});
		expect(reconcileEnvironmentComponents).not.toHaveBeenCalled();
	});

	it("refuses a target that is busy, naming its state", async () => {
		mockScope([DEV, { ...PROD, status: "PROVISIONING" }]);
		await expect(promoteEnvironment("p1", "env-dev", "env-prod")).resolves.toEqual({
			ok: false,
			error: "Target environment is provisioning — try again later.",
		});
	});

	it("refuses when there is nothing structural to promote", async () => {
		vi.mocked(diffIsEmpty).mockReturnValue(true);
		await expect(promoteEnvironment("p1", "env-dev", "env-prod")).resolves.toEqual({
			ok: false,
			error: "No structural changes to promote between these environments.",
		});
	});

	it("refuses a second promotion into a target that already has one in flight", async () => {
		insertFails = new Error(
			'duplicate key value violates unique constraint "environment_promotions_one_active_per_target"',
		);
		await expect(promoteEnvironment("p1", "env-dev", "env-prod")).resolves.toEqual({
			ok: false,
			error: "A promotion into this environment is already in progress.",
		});
		expect(reconcileEnvironmentComponents).not.toHaveBeenCalled();
	});

	it("returns the PLAN gate's sentence, fails the promotion, and writes the target's design back", async () => {
		const gate = "No cloud account linked to this project. Go to Connectors to connect.";
		vi.mocked(tryPlanProject).mockResolvedValue({ ok: false, error: gate });

		await expect(promoteEnvironment("p1", "env-dev", "env-prod")).resolves.toEqual({
			ok: false,
			error: `${gate} The promotion was stopped and production was left as it was.`,
		});

		expect(tryPlanProject).toHaveBeenCalledWith("p1", null, "env-prod");
		// The promotion no longer holds the target's in-flight slot, and says why.
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			status: "FAILED",
			error_message: `The plan was refused: ${gate}`,
		});
		// First the candidate, then the target's own previous design.
		expect(vi.mocked(reconcileEnvironmentComponents).mock.calls).toEqual([
			["p1", "env-prod", { design: "merged" }],
			["p1", "env-prod", { design: "env-prod" }],
		]);
	});
});

describe("promoteEnvironment — the queued path", () => {
	it("answers ok with the promotion and its plan job, and records the plan job", async () => {
		await expect(
			promoteEnvironment("p1", "env-dev", "env-prod", { runnerId: "r-1" }),
		).resolves.toEqual({ ok: true, promotionId: "promo-1", planJobId: "job-1" });
		expect(tryPlanProject).toHaveBeenCalledWith("p1", "r-1", "env-prod");
		expect(updates).toEqual([expect.objectContaining({ plan_job_id: "job-1" })]);
		expect(reconcileEnvironmentComponents).toHaveBeenCalledTimes(1);
	});

	it("an environment outside the project still throws — it is not advice", async () => {
		mockScope([DEV]);
		await expect(promoteEnvironment("p1", "env-dev", "env-gone")).rejects.toThrow(
			"Environment not found for this project",
		);
	});
});
