// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approval reads and writes behind the MCP approval tools (lib/ai/mcp/approval-store.ts), over a
// stood-in transaction and approval engine: each runs in the actor's own tenancy scope, an approval
// is read back through `readApproval` (so visibility is the engine's), and a destroy is approved only
// against a plan that was actually deployed to an environment the actor may view.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/approvals/read", () => ({ readApproval: vi.fn(), viewOf: vi.fn() }));
vi.mock("@/lib/approvals/request", () => ({ requestApproval: vi.fn() }));
vi.mock("@/lib/approvals/context", () => ({ readEnvironment: vi.fn() }));
vi.mock("@/lib/approvals/binding", () => ({ appliedState: vi.fn() }));

import {
	appliedPlanFor,
	findOwnApproval,
	readOwnOrgApproval,
	requestOwnApproval,
} from "@/lib/ai/mcp/approval-store";
import { appliedState } from "@/lib/approvals/binding";
import { readEnvironment } from "@/lib/approvals/context";
import { type ApprovalView, readApproval, viewOf } from "@/lib/approvals/read";
import { ApprovalError } from "@/lib/approvals/refusal";
import { requestApproval } from "@/lib/approvals/request";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { txAnswering } from "./tx-stub";

const ACTOR: Actor = {
	userId: "user-1",
	orgId: "org-1",
	credential: "agent_oauth",
	credentialRef: "client-1",
	ceiling: { scopes: ["read", "apply", "destroy"], projectIds: null },
};

const VIEW: ApprovalView = {
	id: "apr-1",
	status: "pending",
	operation: "deploy",
	project_id: "proj-1",
	environment_id: "env-1",
	plan_job_id: "plan-1",
	digest_prefix: "9f3c1a7e",
	expires_at: "2026-11-24T12:00:00.000Z",
	decided_at: null,
	decision_reason: null,
	consumed_job_id: null,
};

/** Runs every `withActorScope` callback against `tx`, recording the actor it was scoped to. */
function scopeTo(tx: ReturnType<typeof txAnswering>) {
	vi.mocked(withActorScope).mockImplementation(
		// The stub cannot satisfy drizzle's PgTransaction type; the same shape addons-version.test.ts uses.
		((_actor: Actor, cb: (t: unknown) => unknown) => cb(tx)) as never,
	);
}

/** A PDP that answers `allowed` to every check. */
function pdpAllowing(allowed: boolean) {
	const can = vi.fn(async () => ({ allowed }));
	vi.mocked(getPdp).mockReturnValue({ can } as never);
	return can;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("findOwnApproval", () => {
	it("reads the newest matching approval back through readApproval, in the actor's scope", async () => {
		const tx = txAnswering([{ id: "apr-1" }]);
		scopeTo(tx);
		vi.mocked(readApproval).mockResolvedValue(VIEW);

		expect(await findOwnApproval(ACTOR, "plan-1", "deploy")).toEqual(VIEW);
		expect(withActorScope).toHaveBeenCalledWith(ACTOR, expect.any(Function));
		expect(readApproval).toHaveBeenCalledWith(tx, ACTOR, "apr-1");
	});

	it("answers null when this credential has asked for none, and reads nothing further", async () => {
		scopeTo(txAnswering([]));
		expect(await findOwnApproval(ACTOR, "plan-1", "destroy")).toBeNull();
		expect(readApproval).not.toHaveBeenCalled();
	});

	it("matches an actor with no credential reference too", async () => {
		scopeTo(txAnswering([]));
		expect(await findOwnApproval({ ...ACTOR, credentialRef: undefined }, "plan-1", "deploy")).toBeNull();
	});
});

describe("requestOwnApproval", () => {
	it("records the request through the engine and answers its view", async () => {
		const tx = txAnswering();
		scopeTo(tx);
		const recorded = { id: "apr-1" };
		vi.mocked(requestApproval).mockResolvedValue(recorded as never);
		vi.mocked(viewOf).mockResolvedValue(VIEW);

		const input = { planJobId: "plan-1", operation: "deploy" as const, reason: "ship it" };
		expect(await requestOwnApproval(ACTOR, input)).toEqual(VIEW);
		expect(requestApproval).toHaveBeenCalledWith(tx, ACTOR, input);
		expect(viewOf).toHaveBeenCalledWith(tx, recorded);
	});
});

describe("readOwnOrgApproval", () => {
	it("reads through readApproval in the actor's scope", async () => {
		const tx = txAnswering();
		scopeTo(tx);
		vi.mocked(readApproval).mockResolvedValue(VIEW);
		expect(await readOwnOrgApproval(ACTOR, "apr-1")).toEqual(VIEW);
		expect(readApproval).toHaveBeenCalledWith(tx, ACTOR, "apr-1");
	});
});

describe("appliedPlanFor", () => {
	it("refuses not_found, reading nothing, when the actor may not view the project", async () => {
		const can = pdpAllowing(false);
		scopeTo(txAnswering());
		await expect(appliedPlanFor(ACTOR, "proj-1", "env-1")).rejects.toMatchObject({ code: "not_found" });
		expect(can).toHaveBeenCalledWith(ACTOR, "view", { type: "project", id: "proj-1" });
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("refuses not_found when the environment is not one of the project's", async () => {
		pdpAllowing(true);
		scopeTo(txAnswering());
		vi.mocked(readEnvironment).mockResolvedValue(null);
		const refusal = appliedPlanFor(ACTOR, "proj-1", "env-other");
		await expect(refusal).rejects.toBeInstanceOf(ApprovalError);
		await expect(refusal).rejects.toMatchObject({ code: "not_found" });
		expect(appliedState).not.toHaveBeenCalled();
	});

	it("refuses plan_not_approvable when nothing reviewed was deployed there", async () => {
		pdpAllowing(true);
		scopeTo(txAnswering());
		vi.mocked(readEnvironment).mockResolvedValue({ id: "env-1" } as never);
		vi.mocked(appliedState).mockResolvedValue({ deployJobId: "d1", planJobId: null, planSha256: null, createdAt: new Date() });
		await expect(appliedPlanFor(ACTOR, "proj-1", "env-1")).rejects.toMatchObject({ code: "plan_not_approvable" });

		vi.mocked(appliedState).mockResolvedValue(null);
		await expect(appliedPlanFor(ACTOR, "proj-1", "env-1")).rejects.toMatchObject({ code: "plan_not_approvable" });
	});

	it("answers the plan the environment's latest deploy applied", async () => {
		pdpAllowing(true);
		const tx = txAnswering();
		scopeTo(tx);
		vi.mocked(readEnvironment).mockResolvedValue({ id: "env-1" } as never);
		vi.mocked(appliedState).mockResolvedValue({ deployJobId: "d1", planJobId: "plan-9", planSha256: "abc", createdAt: new Date() });
		expect(await appliedPlanFor(ACTOR, "proj-1", "env-1")).toBe("plan-9");
		expect(readEnvironment).toHaveBeenCalledWith(tx, "proj-1", "env-1");
		expect(appliedState).toHaveBeenCalledWith(tx, "env-1");
	});
});
