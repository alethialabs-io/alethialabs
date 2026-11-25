// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Requesting an approval (lib/approvals/request.ts): only against this org's succeeded, current plan
// with a digest and no failed verification, by a caller holding the verb; a destroy names the plan the
// environment's current state was deployed from; the row is bound to the requesting credential.

import { beforeEach, describe, expect, it, vi } from "vitest";

const can = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can }) }));
const enterprise = vi.hoisted((): EnterpriseSlot => ({ current: null }));
vi.mock("@/lib/approvals/enterprise-policy", () => ({ enterpriseAgentPolicy: async () => enterprise.current }));

import { ApprovalError } from "@/lib/approvals/refusal";
import { requestApproval } from "@/lib/approvals/request";
import type { Actor } from "@/lib/authz/types";
import { applyApprovals, jobs, orgAgentPolicy, projectEnvironments } from "@/lib/db/schema";
import { type EnterpriseSlot, fakeEnterprisePolicy } from "./fake-enterprise-policy";
import { fakeExecutor } from "./fake-executor";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const PLAN = "00000000-0000-4000-8000-000000000030";
const DIGEST = "ab".repeat(32);
const AT = new Date("2026-11-24T10:00:00Z");
const TOKEN_ACTOR: Actor = { userId: "u1", orgId: ORG, credential: "service_token", credentialRef: "tok-1" };

function planRow(overrides: Record<string, unknown> = {}) {
	return {
		id: PLAN,
		org_id: ORG,
		project_id: "project",
		environment_id: "env",
		status: "SUCCESS",
		configuration_hash: "cfg",
		plan_sha256: DIGEST,
		execution_metadata: null,
		...overrides,
	};
}

/** A current plan as the binding reads it (plan, nothing since, no newer plan). */
const current = (): unknown[][] => [[{ status: "SUCCESS", created_at: AT, plan_sha256: DIGEST, execution_metadata: null }], [], []];

function setup(
	plan: unknown[],
	jobReads: unknown[][] = current(),
	live: unknown[] = [{ id: "approval-1" }],
	policy: unknown[] = [],
) {
	return fakeExecutor(
		new Map<unknown, unknown[][]>([
			[jobs, [plan, ...jobReads]],
			[projectEnvironments, [[{ stage: "staging", name: "staging" }]]],
			[orgAgentPolicy, [policy]],
			[applyApprovals, [live]],
		]),
	);
}

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

describe("requestApproval", () => {
	it("records a pending approval bound to the plan digest and the requesting token", async () => {
		const f = setup([planRow()]);
		await expect(requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "deploy", reason: "  first  " })).resolves.toEqual({
			id: "approval-1",
		});
		const insert = f.writes.find((w) => w.kind === "insert");
		expect(insert?.values).toEqual(
			expect.objectContaining({
				org_id: ORG,
				plan_job_id: PLAN,
				plan_sha256: DIGEST,
				requester_credential: "service_token",
				requester_credential_ref: "tok-1",
				reason: "first",
			}),
		);
		expect(can).toHaveBeenCalledWith(TOKEN_ACTOR, "deploy", { type: "project", id: "project" });
	});

	it("reads another org's plan as not found", async () => {
		const f = setup([planRow({ org_id: "00000000-0000-4000-8000-0000000000bb" })]);
		expect(await codeOf(requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "deploy" }))).toBe("not_found");
		expect(f.writes).toEqual([]);
	});

	it("reads a plan the caller may not deploy as not found", async () => {
		can.mockResolvedValue({ allowed: false });
		const f = setup([planRow()]);
		expect(await codeOf(requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "deploy" }))).toBe("not_found");
	});

	it.each([
		["a plan that has not succeeded", planRow({ status: "PROCESSING" })],
		["a plan with no digest", planRow({ plan_sha256: null })],
		[
			"a plan that failed verification",
			planRow({ execution_metadata: { verify_receipt: { receipt: { verdict: "fail", plan_sha256: DIGEST } } } }),
		],
	])("refuses %s", async (_name, plan) => {
		const f = setup([plan]);
		expect(await codeOf(requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "deploy" }))).toBe(
			"plan_not_approvable",
		);
		expect(f.writes).toEqual([]);
	});

	it("refuses a plan that is no longer current", async () => {
		const f = setup([planRow()], [[{ status: "SUCCESS", created_at: AT, plan_sha256: DIGEST, execution_metadata: null }], [{ id: "later" }]]);
		expect(await codeOf(requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "deploy" }))).toBe(
			"plan_not_approvable",
		);
	});

	it("refuses a destroy against a plan the environment's current state was not deployed from", async () => {
		const f = setup([planRow()], [[{ id: "deploy", plan_job_id: "other-plan", plan_sha256: DIGEST, created_at: AT }]]);
		expect(await codeOf(requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "destroy" }))).toBe(
			"plan_not_approvable",
		);
	});

	it("accepts a destroy against the plan the environment's current state was deployed from", async () => {
		const applied = { id: "deploy", plan_job_id: PLAN, plan_sha256: DIGEST, created_at: AT };
		const f = setup([planRow()], [[applied], [applied], []]);
		await expect(requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "destroy" })).resolves.toEqual({ id: "approval-1" });
		expect(can).toHaveBeenCalledWith(TOKEN_ACTOR, "destroy", { type: "project", id: "project" });
	});
});

// AGT-L14: the OAuth client allow-list, asked through the enterprise agent policy.
describe("requestApproval — the OAuth client allow-list", () => {
	const ALLOW_LIST = [
		{
			agent_access_enabled: true,
			agents_may_not_apply_to_production: false,
			require_different_approver: false,
			approval_ttl_minutes: 60,
			allowed_oauth_client_ids: ["claude-code"],
		},
	];
	const oauth = (clientId: string): Actor => ({ userId: "u1", orgId: ORG, credential: "agent_oauth", credentialRef: clientId });

	it("refuses a client outside the list before anything is written", async () => {
		const fake = fakeEnterprisePolicy(true);
		enterprise.current = fake.policy;
		const f = setup([planRow()], current(), [{ id: "approval-1" }], ALLOW_LIST);
		expect(await codeOf(requestApproval(f.db, oauth("cursor"), { planJobId: PLAN, operation: "deploy" }))).toBe("not_permitted");
		expect(fake.oauthClientRefusal).toHaveBeenCalledWith(ORG, expect.objectContaining({ allowedOauthClientIds: ["claude-code"] }), "cursor");
		expect(f.writes).toEqual([]);
	});

	it("records the request of a listed client", async () => {
		enterprise.current = fakeEnterprisePolicy(true).policy;
		const f = setup([planRow()], current(), [{ id: "approval-1" }], ALLOW_LIST);
		await expect(requestApproval(f.db, oauth("claude-code"), { planJobId: PLAN, operation: "deploy" })).resolves.toEqual({
			id: "approval-1",
		});
	});

	it("records the request of any client when the organization is not entitled (unlicensed = core)", async () => {
		enterprise.current = fakeEnterprisePolicy(false).policy;
		const f = setup([planRow()], current(), [{ id: "approval-1" }], ALLOW_LIST);
		await expect(requestApproval(f.db, oauth("cursor"), { planJobId: PLAN, operation: "deploy" })).resolves.toEqual({
			id: "approval-1",
		});
	});

	it("does not ask about a credential that is not an OAuth client", async () => {
		const fake = fakeEnterprisePolicy(true);
		enterprise.current = fake.policy;
		const f = setup([planRow()], current(), [{ id: "approval-1" }], ALLOW_LIST);
		await requestApproval(f.db, TOKEN_ACTOR, { planJobId: PLAN, operation: "deploy" });
		expect(fake.oauthClientRefusal).not.toHaveBeenCalled();
	});
});
