// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The console half of plan-bound apply (AGT-S0b, #6780): what a DEPLOY is stamped with, and which
// named plans a deploy may apply. The module is real; the transaction is a stub that answers the two
// reads `resolveReviewedPlan` makes (the plan, then "anything queued since"). The same rule against
// real Postgres, through the actions, is tests/integration/plan-binding.test.ts.

import { describe, expect, it } from "vitest";
import {
	configurationHashOf,
	PlanBindingError,
	planDigestOf,
	receiptPlanDigest,
	resolveReviewedPlan,
} from "@/lib/approvals/plan-binding";
import type { Tx } from "@/lib/db";
import type { ExecutionMetadata, SignedReceipt } from "@/types/jsonb.types";

const PLAN = "11111111-1111-4111-8111-111111111111";
const DIGEST = "ab".repeat(32);
const HASH = "cd".repeat(32);

/** Execution metadata whose verify receipt records `planSha256`. */
function withReceipt(planSha256: string): ExecutionMetadata {
	const receipt: SignedReceipt = {
		receipt: {
			version: "1",
			plan_sha256: planSha256,
			catalog_version: "1",
			provider: "aws",
			verdict: "pass",
			report: {
				provider: "aws",
				verdict: "pass",
				catalog_version: "1",
				controls: [],
				summary: { pass: 0, fail: 0, warn: 0, not_evaluable: 0 },
			},
		},
		algorithm: "none",
	};
	return { verify_receipt: receipt };
}

/** A succeeded, current plan row as the plan read answers it. */
function planRow(overrides: Record<string, unknown> = {}) {
	return {
		id: PLAN,
		status: "SUCCESS",
		configuration_hash: HASH,
		plan_sha256: DIGEST,
		execution_metadata: null,
		created_at: new Date("2026-11-23T10:00:00Z"),
		...overrides,
	};
}

/**
 * A transaction stub: the first SELECT answers `plan`, the second `laterRun`. Every SELECT is
 * recorded so a test can see a refusal happened before any read.
 */
function txAnswering(plan: unknown[], laterRun: unknown[] = []) {
	const answers = [plan, laterRun];
	let selects = 0;
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => {
			selects += 1;
			return chain;
		},
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(answers.shift() ?? []),
	});
	// The stub implements only the two reads the function makes; it stands in for the full Tx.
	const tx = chain as never as Tx;
	return { tx, selects: () => selects };
}

/** Resolves against the stub with the standard target. */
async function resolveWith(tx: Tx, planJobId: string | null = PLAN) {
	return resolveReviewedPlan(tx, {
		projectId: "p1",
		environmentId: "e1",
		planJobId,
		configurationHash: HASH,
	});
}

describe("configurationHashOf", () => {
	it("is SHA-256 hex, and the same whatever key order the snapshot has (jsonb reorders keys)", () => {
		const a = configurationHashOf({ b: 1, a: { d: [1, 2], c: "x" } });
		const b = configurationHashOf({ a: { c: "x", d: [1, 2] }, b: 1 });
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).toBe(b);
	});

	it("moves when a value or an array's order moves, and ignores undefined (absent after a jsonb round trip)", () => {
		const base = configurationHashOf({ a: [1, 2] });
		expect(configurationHashOf({ a: [2, 1] })).not.toBe(base);
		expect(configurationHashOf({ a: [1, 3] })).not.toBe(base);
		expect(configurationHashOf({ a: [1, 2], gone: undefined })).toBe(base);
	});
});

describe("planDigestOf", () => {
	it("reads the stamped column first, normalised to lowercase", () => {
		expect(planDigestOf({ plan_sha256: DIGEST.toUpperCase(), execution_metadata: withReceipt("ef".repeat(32)) })).toBe(DIGEST);
	});

	it("falls back to the verify receipt's digest when the column is empty", () => {
		expect(planDigestOf({ plan_sha256: null, execution_metadata: withReceipt(DIGEST) })).toBe(DIGEST);
	});

	it("is null when neither holds a SHA-256 digest", () => {
		expect(planDigestOf({ plan_sha256: "abc", execution_metadata: withReceipt("not-a-digest") })).toBeNull();
		expect(planDigestOf({ plan_sha256: null, execution_metadata: null })).toBeNull();
		expect(receiptPlanDigest(undefined)).toBeNull();
	});
});

describe("resolveReviewedPlan", () => {
	it("returns the plan id and its digest for a current, succeeded plan with a digest", async () => {
		const { tx } = txAnswering([planRow()]);
		await expect(resolveWith(tx)).resolves.toEqual({ planJobId: PLAN, planSha256: DIGEST });
	});

	it("takes the digest from the receipt for a plan that succeeded before the column was stamped", async () => {
		const { tx } = txAnswering([planRow({ plan_sha256: null, execution_metadata: withReceipt(DIGEST) })]);
		await expect(resolveWith(tx)).resolves.toEqual({ planJobId: PLAN, planSha256: DIGEST });
	});

	it.each([
		["no plan named", null],
		["a blank plan id", "  "],
	])("refuses %s as plan_required, before any read", async (_label, planJobId) => {
		const { tx, selects } = txAnswering([planRow()]);
		await expect(resolveWith(tx, planJobId)).rejects.toMatchObject({
			name: "PlanBindingError",
			code: "plan_required",
			message: "A deploy applies a reviewed plan. Plan this environment, review the plan, then apply it.",
		});
		expect(selects()).toBe(0);
	});

	it("refuses a plan id that is not a job id as plan_not_found, before any read", async () => {
		const { tx, selects } = txAnswering([planRow()]);
		await expect(resolveWith(tx, "plan-3")).rejects.toMatchObject({ code: "plan_not_found" });
		expect(selects()).toBe(0);
	});

	it("refuses a job that is not a PLAN of this project and environment as plan_not_found", async () => {
		const { tx } = txAnswering([]);
		await expect(resolveWith(tx)).rejects.toMatchObject({ code: "plan_not_found" });
	});

	it.each([
		["the plan has not succeeded", planRow({ status: "PROCESSING" }), [], /has not succeeded \(status PROCESSING\)/],
		["the configuration moved since the plan", planRow({ configuration_hash: "ef".repeat(32) }), [], /configuration changed/],
		["the plan predates the configuration hash", planRow({ configuration_hash: null }), [], /configuration changed/],
		["a build, deploy or destroy was queued after the plan", planRow(), [{ id: "later" }], /queued after plan/],
	])("refuses as plan_not_current when %s, saying to plan again", async (_label, row, later, message) => {
		const { tx } = txAnswering([row], later);
		const refusal = resolveWith(tx);
		await expect(refusal).rejects.toBeInstanceOf(PlanBindingError);
		await expect(refusal).rejects.toMatchObject({ code: "plan_not_current", message: expect.stringMatching(message) });
		await expect(refusal).rejects.toMatchObject({ message: expect.stringMatching(/Plan again|plan again/) });
	});

	it("refuses a current plan with no recorded digest as plan_digest_missing", async () => {
		const { tx } = txAnswering([planRow({ plan_sha256: null, execution_metadata: null })]);
		await expect(resolveWith(tx)).rejects.toMatchObject({
			code: "plan_digest_missing",
			message: expect.stringMatching(/Plan again, review the new plan, then apply it\.$/),
		});
	});
});
