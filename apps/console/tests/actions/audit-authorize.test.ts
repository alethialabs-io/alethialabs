// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for `queueAudit`'s authorization branch (#2697).
//
// The integration suite (tests/integration/audit-authz.test.ts) proves the PDP actually DENIES,
// which is the property that matters and which a mocked test cannot establish. These prove the
// complementary thing it cannot: that the right gate is CALLED, with the right verb and the right
// resource, on the attached path — and that the unattached path still resolves identity only.
//
// Both are needed. A mocked test alone would pass against an `authorize()` that permits everything;
// an integration test alone cannot run where there is no database, which is where the coverage
// ratchet reads.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(), currentActor: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn(async () => {}) }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/lib/db/signed-job", () => ({ signedJob: vi.fn((v) => v) }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { queueAudit } from "@/app/server/actions/audit";
import { authorize, currentActor } from "@/lib/authz/guard";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { withActorScope } from "@/lib/db";

const ACTOR = { userId: "u1", orgId: "o1" };
const PROJECT = "11111111-2222-4333-8444-555555555555";

/** Captures the row handed to `.values()` so the project stamp can be asserted. */
let inserted: Record<string, unknown> | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	inserted = undefined;
	vi.mocked(currentActor).mockResolvedValue(ACTOR as never);
	vi.mocked(authorize).mockResolvedValue(ACTOR as never);
	vi.mocked(withActorScope).mockImplementation(async (_actor: unknown, fn: unknown) => {
		const tx: Record<string, unknown> = {};
		Object.assign(tx, {
			insert: () => tx,
			values: (v: Record<string, unknown>) => {
				inserted = v;
				return tx;
			},
			returning: async () => [{ id: "job-1" }],
		});
		return (fn as (t: unknown) => Promise<string>)(tx);
	});
});

describe("queueAudit authorization", () => {
	// THE DEFECT. Before #2697 this path called `currentActor()` and nothing else, so any caller in
	// the org could attach an AUDIT job to any project — including the model, which is handed
	// `projectId` as a free optional string by the audit_infrastructure tool.
	it("authorizes the PROJECT when one is named", async () => {
		await queueAudit("{}", "plan", PROJECT);
		expect(authorize).toHaveBeenCalledWith("audit", { type: "project", id: PROJECT });
	});

	it("...with the audit verb, not a borrowed one", async () => {
		await queueAudit("{}", "plan", PROJECT);
		expect(vi.mocked(authorize).mock.calls[0][0]).toBe("audit");
	});

	it("...and identity alone is not enough on that path", async () => {
		await queueAudit("{}", "plan", PROJECT);
		expect(currentActor).not.toHaveBeenCalled();
	});

	// A refusal must stop the insert, not merely be recorded.
	it("a refused authorization writes no job", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Forbidden"));
		await expect(queueAudit("{}", "plan", PROJECT)).rejects.toThrow("Forbidden");
		expect(withActorScope).not.toHaveBeenCalled();
		expect(assertJobQuotaAllowed).not.toHaveBeenCalled();
	});

	// The unattached audit is legitimate — a plan belonging to no project yet — and closing the
	// hole must not take it away. Identity alone is the correct bar with no id to authorize against.
	it("does NOT authorize a project when none is named", async () => {
		const { jobId } = await queueAudit("{}", "plan");
		expect(authorize).not.toHaveBeenCalled();
		expect(currentActor).toHaveBeenCalledOnce();
		expect(jobId).toBe("job-1");
	});

	it("...and the row then carries no project_id", async () => {
		await queueAudit("{}", "plan");
		expect(inserted).toBeDefined();
		expect("project_id" in (inserted ?? {})).toBe(false);
	});

	it("an attached audit stamps the project it authorized", async () => {
		await queueAudit("{}", "manifests", PROJECT);
		expect(inserted?.project_id).toBe(PROJECT);
	});

	// Pre-existing contract, kept: empty input is refused, and AFTER the gate — so an unauthorized
	// caller learns nothing about the project from the error they get.
	it("refuses empty input, and only after authorizing", async () => {
		await expect(queueAudit("   ", "plan", PROJECT)).rejects.toThrow(/Audit input is required/);
		expect(authorize).toHaveBeenCalledOnce();
	});
});
