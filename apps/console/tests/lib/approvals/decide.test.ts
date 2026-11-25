// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Deciding an approval (lib/approvals/decide.ts): only a person in a recent console session, in the
// approval's org, holding the verb on the project; never a token or an agent; never the requester's
// own person when the org requires a different approver and the enterprise agent policy applies it;
// a destroy needs the typed environment name.

import { beforeEach, describe, expect, it, vi } from "vitest";

const can = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can }) }));
const enterprise = vi.hoisted((): EnterpriseSlot => ({ current: null }));
vi.mock("@/lib/approvals/enterprise-policy", () => ({ enterpriseAgentPolicy: async () => enterprise.current }));

import { type Decider, decideApproval, DECIDER_SESSION_MAX_AGE_MS } from "@/lib/approvals/decide";
import { ApprovalError } from "@/lib/approvals/refusal";
import { CREDENTIAL_KINDS, type CredentialKind } from "@/lib/authz/types";
import { applyApprovals, jobs, orgAgentPolicy, projectEnvironments } from "@/lib/db/schema";
import { type EnterpriseSlot, fakeEnterprisePolicy } from "./fake-enterprise-policy";
import { fakeExecutor, untouchableTx } from "./fake-executor";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const REQUESTER = "00000000-0000-4000-8000-000000000001";
const APPROVER = "00000000-0000-4000-8000-000000000002";
const APPROVAL = "00000000-0000-4000-8000-000000000050";
const DIGEST = "ab".repeat(32);
const NOW = new Date("2026-11-24T12:00:00Z");

const decider = (credential: CredentialKind = "session", userId = APPROVER, signedInAgoMs = 60_000): Decider => ({
	actor: { userId, orgId: ORG, credential },
	sessionId: "00000000-0000-4000-8000-0000000000ee",
	sessionCreatedAt: new Date(NOW.getTime() - signedInAgoMs),
});

function pending(overrides: Record<string, unknown> = {}) {
	return {
		id: APPROVAL,
		org_id: ORG,
		project_id: "project",
		environment_id: "env",
		operation: "deploy",
		plan_job_id: "plan",
		plan_sha256: DIGEST,
		requester_user_id: REQUESTER,
		requester_credential: "agent_oauth",
		status: "pending",
		expires_at: new Date(NOW.getTime() + 30 * 60_000),
		...overrides,
	};
}

/** A current plan, as the binding reads it: succeeded, nothing since, no newer plan. */
const currentPlan = (): unknown[][] => [[{ status: "SUCCESS", created_at: NOW, plan_sha256: DIGEST, execution_metadata: null }], [], []];

function setup(approval: unknown[], opts: { differentApprover?: boolean; plan?: unknown[][]; envName?: string } = {}) {
	return fakeExecutor(
		new Map<unknown, unknown[][]>([
			[applyApprovals, [approval]],
			[jobs, opts.plan ?? currentPlan()],
			[
				orgAgentPolicy,
				[opts.differentApprover ? [{ agent_access_enabled: true, agents_may_not_apply_to_production: false, require_different_approver: true, approval_ttl_minutes: 60 }] : []],
			],
			[projectEnvironments, [[{ stage: "staging", name: opts.envName ?? "staging" }]]],
		]),
		new Map<unknown, unknown[][]>([[applyApprovals, [[{ ...pending(), status: "approved" }]]]]),
	);
}

/** The ApprovalError code a promise rejects with. */
async function codeOf(p: Promise<unknown>): Promise<string> {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	if (!(err instanceof ApprovalError)) throw new Error(`expected an ApprovalError, got ${String(err)}`);
	return err.code;
}

beforeEach(() => {
	enterprise.current = null;
	can.mockReset();
	can.mockResolvedValue({ allowed: true });
});

describe("who may decide", () => {
	it.each(CREDENTIAL_KINDS.filter((c) => c !== "session"))("a %s actor is refused before anything is read", async (credential) => {
		expect(await codeOf(decideApproval(untouchableTx(), decider(credential), APPROVAL, { decision: "approve" }, NOW))).toBe(
			"not_a_person",
		);
	});

	it("a session older than a day must sign in again", async () => {
		expect(
			await codeOf(
				decideApproval(untouchableTx(), decider("session", APPROVER, DECIDER_SESSION_MAX_AGE_MS + 1), APPROVAL, { decision: "approve" }, NOW),
			),
		).toBe("reauthentication_required");
	});

	it("an approval of another org reads as not found", async () => {
		const f = setup([pending({ org_id: "00000000-0000-4000-8000-0000000000bb" })]);
		expect(await codeOf(decideApproval(f.db, decider(), APPROVAL, { decision: "approve" }, NOW))).toBe("not_found");
		expect(f.writes).toEqual([]);
	});

	it("a person without the verb on the project reads as not found", async () => {
		can.mockResolvedValue({ allowed: false });
		const f = setup([pending()]);
		expect(await codeOf(decideApproval(f.db, decider(), APPROVAL, { decision: "approve" }, NOW))).toBe("not_found");
		expect(can).toHaveBeenCalledWith(expect.objectContaining({ userId: APPROVER }), "deploy", { type: "project", id: "project" });
	});
});

describe("self-approval", () => {
	it("is allowed by default: a person approves what their own agent asked (decision D6)", async () => {
		const f = setup([pending()]);
		const result = await decideApproval(f.db, decider("session", REQUESTER), APPROVAL, { decision: "approve" }, NOW);
		expect(result.ok).toBe(true);
	});

	it("is allowed in core even with the toggle stored on: core does not read it (an enterprise toggle)", async () => {
		const f = setup([pending()], { differentApprover: true });
		const result = await decideApproval(f.db, decider("session", REQUESTER), APPROVAL, { decision: "approve" }, NOW);
		expect(result.ok).toBe(true);
		// The row IS read now — approving re-checks the core kill switch and "keep agents off
		// production" (decidable.ts, AGT-L2 G14) — but with no enterprise policy registered the
		// different-approver toggle in it is not acted on, which is what the approve above shows.
		expect(f.selects.get(orgAgentPolicy)).toBe(1);
	});

	it("is refused when the org requires a different approver and is entitled to it", async () => {
		const fake = fakeEnterprisePolicy(true);
		enterprise.current = fake.policy;
		const f = setup([pending()], { differentApprover: true });
		expect(await codeOf(decideApproval(f.db, decider("session", REQUESTER), APPROVAL, { decision: "approve" }, NOW))).toBe(
			"self_approval",
		);
		expect(fake.approverRefusal).toHaveBeenCalledWith(
			ORG,
			expect.objectContaining({ requireDifferentApprover: true, allowedOauthClientIds: null }),
			REQUESTER,
			REQUESTER,
		);
		expect(f.writes).toEqual([]);
	});

	it("is allowed when the org requires a different approver and is not entitled to it", async () => {
		enterprise.current = fakeEnterprisePolicy(false).policy;
		const f = setup([pending()], { differentApprover: true });
		expect((await decideApproval(f.db, decider("session", REQUESTER), APPROVAL, { decision: "approve" }, NOW)).ok).toBe(true);
	});

	it("is allowed when entitled and the toggle is off", async () => {
		enterprise.current = fakeEnterprisePolicy(true).policy;
		const f = setup([pending()]);
		expect((await decideApproval(f.db, decider("session", REQUESTER), APPROVAL, { decision: "approve" }, NOW)).ok).toBe(true);
	});

	it("a rejection by the requester is never refused as a self-approval", async () => {
		const fake = fakeEnterprisePolicy(true);
		enterprise.current = fake.policy;
		const f = setup([pending()], { differentApprover: true });
		expect((await decideApproval(f.db, decider("session", REQUESTER), APPROVAL, { decision: "reject" }, NOW)).ok).toBe(true);
		expect(fake.approverRefusal).not.toHaveBeenCalled();
	});

	it("lets a different person approve when the org requires one", async () => {
		enterprise.current = fakeEnterprisePolicy(true).policy;
		const f = setup([pending()], { differentApprover: true });
		expect((await decideApproval(f.db, decider(), APPROVAL, { decision: "approve" }, NOW)).ok).toBe(true);
		expect(f.writes[0]?.values).toEqual(
			expect.objectContaining({ status: "approved", approver_user_id: APPROVER, approver_session_id: decider().sessionId }),
		);
	});
});

describe("what can be decided", () => {
	it.each(["approved", "rejected", "expired", "superseded", "consumed"])("a %s approval is not pending", async (status) => {
		const f = setup([pending({ status })]);
		expect(await codeOf(decideApproval(f.db, decider(), APPROVAL, { decision: "approve" }, NOW))).toBe("not_pending");
	});

	it("an approval past its expiry is marked expired, not approved", async () => {
		const f = setup([pending({ expires_at: new Date(NOW.getTime() - 1) })]);
		const result = await decideApproval(f.db, decider(), APPROVAL, { decision: "approve" }, NOW);
		expect(result.ok).toBe(false);
		expect(f.writes.map((w) => w.values)).toEqual([expect.objectContaining({ status: "expired" })]);
	});

	it("an approval whose plan is no longer current is marked superseded", async () => {
		const f = setup([pending()], { plan: [[{ status: "SUCCESS", created_at: NOW, plan_sha256: DIGEST, execution_metadata: null }], [{ id: "later" }]] });
		const result = await decideApproval(f.db, decider(), APPROVAL, { decision: "approve" }, NOW);
		expect(result.ok).toBe(false);
		expect(f.writes.map((w) => w.values)).toEqual([expect.objectContaining({ status: "superseded" })]);
	});

	it("a destroy is approved only with the environment's name typed", async () => {
		const destroy = pending({ operation: "destroy" });
		const applied = (): unknown[][] => [[{ id: "deploy", plan_job_id: "plan", plan_sha256: DIGEST, created_at: NOW }], []];
		const wrong = setup([destroy], { plan: applied(), envName: "production-eu" });
		expect(
			await codeOf(decideApproval(wrong.db, decider(), APPROVAL, { decision: "approve", confirmEnvironmentName: "production" }, NOW)),
		).toBe("confirmation_mismatch");
		const right = setup([destroy], { plan: applied(), envName: "production-eu" });
		expect(
			(await decideApproval(right.db, decider(), APPROVAL, { decision: "approve", confirmEnvironmentName: "production-eu" }, NOW)).ok,
		).toBe(true);
	});
});
