// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The in-product agent on the approval path (agent surface §4.6, issue #6862). The approval engine is
// real (lib/approvals/**) over the fake executor the engine's own tests use; the session, the PDP and
// the scoped transaction are stubbed.
//
// - `request_apply` / `request_destroy` record the request as `agent_in_app`, bound to the conversation,
//   and refuse what table 4.2 refuses an agent (the kill switch, "no agents on production").
// - A deploy or destroy queued as the in-product agent needs an approval; one bound to the plan digest
//   and requested by the same conversation is consumed once; the kill switch refuses it at the gate.
// - The decision is a person's: the agent cannot decide, and the requester's own person is refused when
//   the org requires a different approver.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeExecutor, type FakeExecutor } from "../approvals/fake-executor";

const can = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can }) }));
const currentActor = vi.fn();
vi.mock("@/lib/authz/guard", () => ({ currentActor: () => currentActor() }));
const scoped: { db: FakeExecutor["db"] | null } = { db: null };
vi.mock("@/lib/db", () => ({
	withActorScope: (_actor: unknown, fn: (tx: unknown) => Promise<unknown>) => {
		if (!scoped.db) throw new Error("no scoped executor set for this test");
		return fn(scoped.db);
	},
}));

import { inAppApprovalOutputSchema } from "@/lib/agent/approval-output";
import { requestInAppApproval } from "@/lib/agent/approval-request";
import { inAppAgentActor, isInAppAgent } from "@/lib/agent/in-app-credential";
import { hasAcceptedApproval } from "@/lib/agent/turn-key";
import { operationTools } from "@/lib/ai/tools/operations";
import { decideApproval } from "@/lib/approvals/decide";
import { ApprovalError } from "@/lib/approvals/refusal";
import { ApplyAuthorizationError, requireApplyAuthorization } from "@/lib/approvals/types";
import type { Actor } from "@/lib/authz/types";
import { applyApprovals, jobs, orgAgentPolicy, projectEnvironments } from "@/lib/db/schema";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_PERSON = "00000000-0000-4000-8000-000000000002";
const PROJECT = "00000000-0000-4000-8000-000000000010";
const ENV = "00000000-0000-4000-8000-000000000020";
const PLAN = "00000000-0000-4000-8000-000000000030";
const JOB = "00000000-0000-4000-8000-000000000040";
const APPROVAL = "00000000-0000-4000-8000-000000000050";
const THREAD = "00000000-0000-4000-8000-000000000070";
const OTHER_THREAD = "00000000-0000-4000-8000-000000000071";
const DIGEST = "9f3c1a7e".repeat(8);
const PLANNED_AT = new Date("2026-11-24T10:00:00Z");

const PERSON: Actor = { userId: USER, orgId: ORG, credential: "session" };
const AGENT = inAppAgentActor(PERSON, THREAD);

/** A policy row with `overrides` over the column defaults. */
function policy(overrides: Record<string, unknown> = {}) {
	return {
		agent_access_enabled: true,
		agents_may_not_apply_to_production: false,
		require_different_approver: false,
		approval_ttl_minutes: 60,
		...overrides,
	};
}

/** A current plan as the binding reads it: succeeded with the digest, nothing since, no newer plan. */
const currentPlan = (): unknown[][] => [
	[{ status: "SUCCESS", created_at: PLANNED_AT, plan_sha256: DIGEST, execution_metadata: null }],
	[],
	[],
];

/** An approval row bound to the plan and this conversation, with `overrides`. */
function approvalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: APPROVAL,
		org_id: ORG,
		project_id: PROJECT,
		environment_id: ENV,
		operation: "deploy",
		plan_job_id: PLAN,
		plan_sha256: DIGEST,
		config_hash: "cfg",
		requester_user_id: USER,
		requester_credential: "agent_in_app",
		requester_credential_ref: THREAD,
		reason: null,
		status: "pending",
		approver_user_id: null,
		approver_session_id: null,
		decided_at: null,
		expires_at: new Date(Date.now() + 30 * 60_000),
		consumed_at: null,
		consumed_job_id: null,
		created_at: PLANNED_AT,
		updated_at: PLANNED_AT,
		...overrides,
	};
}

/** The executor a request reads through: the plan, the environment, the policy, then the live row. */
function requestSetup(opts: { stage?: string; policy?: Record<string, unknown>[] } = {}) {
	return fakeExecutor(
		new Map<unknown, unknown[][]>([
			[
				jobs,
				[
					[
						{
							id: PLAN,
							org_id: ORG,
							project_id: PROJECT,
							environment_id: ENV,
							status: "SUCCESS",
							configuration_hash: "cfg",
							plan_sha256: DIGEST,
							execution_metadata: null,
						},
					],
					// The request's binding check, then the view's.
					...currentPlan(),
					...currentPlan(),
				],
			],
			[projectEnvironments, [[{ stage: opts.stage ?? "staging", name: "staging" }]]],
			[orgAgentPolicy, [opts.policy ?? []]],
			[applyApprovals, [[approvalRow()]]],
		]),
	);
}

/** The approval row the request inserted. */
function inserted(fake: FakeExecutor): Record<string, unknown> | undefined {
	const write = fake.writes.find((w) => w.kind === "insert" && w.table === applyApprovals);
	const values = write?.values;
	return values && typeof values === "object" ? Object.fromEntries(Object.entries(values)) : undefined;
}

beforeEach(() => {
	can.mockReset();
	can.mockResolvedValue({ allowed: true });
	currentActor.mockReset();
	currentActor.mockResolvedValue(AGENT);
	scoped.db = null;
});

describe("the in-product agent's credential", () => {
	it("is the person's actor relabelled agent_in_app and bound to the conversation", () => {
		expect(AGENT).toEqual({ userId: USER, orgId: ORG, credential: "agent_in_app", credentialRef: THREAD });
		expect(isInAppAgent(AGENT)).toBe(true);
		expect(isInAppAgent(PERSON)).toBe(false);
	});
});

describe("request_apply / request_destroy", () => {
	it("records the request as agent_in_app, bound to the conversation, and queues nothing", async () => {
		const fake = requestSetup();
		scoped.db = fake.db;
		const execute = operationTools().request_apply.execute;
		if (!execute) throw new Error("request_apply must execute on the server");
		const output = inAppApprovalOutputSchema.parse(
			await execute({ plan_job_id: PLAN, reason: "initial staging cluster" }, { toolCallId: "t1", messages: [] }),
		);
		expect(output).toEqual({
			status: "requested",
			approval_id: APPROVAL,
			approval_status: "pending",
			operation: "deploy",
			project_id: PROJECT,
			environment_id: ENV,
			plan_job_id: PLAN,
			digest_prefix: "9f3c1a7e",
			expires_at: expect.any(String),
		});
		expect(inserted(fake)).toMatchObject({
			requester_user_id: USER,
			requester_credential: "agent_in_app",
			requester_credential_ref: THREAD,
			plan_job_id: PLAN,
			plan_sha256: DIGEST,
			operation: "deploy",
		});
		expect(fake.writes.some((w) => w.table === jobs)).toBe(false);
	});

	it("is refused outside a chat turn, so a request is never recorded as a person's session", async () => {
		currentActor.mockResolvedValue(PERSON);
		const fake = requestSetup();
		scoped.db = fake.db;
		await expect(requestInAppApproval("deploy", { plan_job_id: PLAN })).resolves.toMatchObject({
			status: "refused",
			code: "not_permitted",
		});
		expect(fake.writes).toHaveLength(0);
	});

	it("refuses a plan id that is not a UUID before reading anything", async () => {
		await expect(requestInAppApproval("deploy", { plan_job_id: "plan-from-the-prompt" })).resolves.toMatchObject({
			status: "refused",
			code: "not_found",
		});
	});

	it("is refused when the org's kill switch is off", async () => {
		const fake = requestSetup({ policy: [policy({ agent_access_enabled: false })] });
		scoped.db = fake.db;
		const out = await requestInAppApproval("deploy", { plan_job_id: PLAN });
		expect(out).toMatchObject({ status: "refused", code: "not_permitted" });
		expect(out.status === "refused" && out.reason).toContain("Agent access is turned off");
		expect(inserted(fake)).toBeUndefined();
	});

	it.each(["deploy", "destroy"] as const)(
		"%s on production is refused when agents may not apply to production",
		async (operation) => {
			const fake = requestSetup({ stage: "production", policy: [policy({ agents_may_not_apply_to_production: true })] });
			scoped.db = fake.db;
			const out = await requestInAppApproval(operation, { plan_job_id: PLAN });
			expect(out).toMatchObject({ status: "refused", code: "not_permitted" });
			expect(inserted(fake)).toBeUndefined();
		},
	);
});

describe("queueing as the in-product agent (the queue gate)", () => {
	const TARGET = { orgId: ORG, projectId: PROJECT, environmentId: ENV, jobId: JOB, planJobId: PLAN };

	/** The executor one gate call reads through. */
	function gateSetup(opts: { approval?: Record<string, unknown>; policy?: Record<string, unknown>[]; cas?: unknown[] } = {}) {
		const plan = [{ status: "SUCCESS", created_at: PLANNED_AT, plan_sha256: DIGEST, execution_metadata: null }];
		return fakeExecutor(
			new Map<unknown, unknown[][]>([
				[projectEnvironments, [[{ stage: "staging", name: "staging" }]]],
				[orgAgentPolicy, [opts.policy ?? []]],
				[applyApprovals, [[opts.approval ?? approvalRow({ status: "approved" })]]],
				[jobs, [plan, plan, [], []]],
			]),
			new Map<unknown, unknown[][]>([[applyApprovals, [opts.cas ?? [{ id: APPROVAL }]]]]),
		);
	}

	/** The refusal code a gate call rejects with. */
	async function refusedWith(p: Promise<unknown>): Promise<string> {
		const err = await p.then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof ApplyAuthorizationError)) throw new Error(`expected a refusal, got ${String(err)}`);
		return err.code;
	}

	it.each(["deploy", "destroy"] as const)("a %s with no approval is refused", async (operation) => {
		const fake = gateSetup();
		expect(await refusedWith(requireApplyAuthorization(fake.db, { kind: "actor", actor: AGENT }, operation, TARGET))).toBe(
			"approval_required",
		);
	});

	it("an approved request of this conversation, bound to the plan digest, is consumed once", async () => {
		const fake = gateSetup();
		await expect(
			requireApplyAuthorization(fake.db, { kind: "actor", actor: AGENT }, "deploy", TARGET, APPROVAL),
		).resolves.toEqual({ approvalId: APPROVAL });
		expect(fake.writes.find((w) => w.table === applyApprovals)?.values).toMatchObject({ status: "consumed", consumed_job_id: JOB });

		// The second use loses the compare-and-set on `consumed_at IS NULL`.
		const again = gateSetup({ cas: [] });
		expect(
			await refusedWith(requireApplyAuthorization(again.db, { kind: "actor", actor: AGENT }, "deploy", TARGET, APPROVAL)),
		).toBe("approval_invalid");
	});

	it("an approval another conversation requested is not this one's to use", async () => {
		const fake = gateSetup({ approval: approvalRow({ status: "approved", requester_credential_ref: OTHER_THREAD }) });
		expect(
			await refusedWith(requireApplyAuthorization(fake.db, { kind: "actor", actor: AGENT }, "deploy", TARGET, APPROVAL)),
		).toBe("approval_invalid");
	});

	it("an approval of a different digest is refused", async () => {
		const fake = gateSetup({ approval: approvalRow({ status: "approved", plan_sha256: "00".repeat(32) }) });
		expect(
			await refusedWith(requireApplyAuthorization(fake.db, { kind: "actor", actor: AGENT }, "deploy", TARGET, APPROVAL)),
		).toBe("approval_invalid");
	});

	it("a request a person has not decided yet does not queue", async () => {
		const fake = gateSetup({ approval: approvalRow({ status: "pending" }) });
		expect(
			await refusedWith(requireApplyAuthorization(fake.db, { kind: "actor", actor: AGENT }, "deploy", TARGET, APPROVAL)),
		).toBe("approval_required");
	});

	it("the kill switch refuses the job even with an approved request", async () => {
		const fake = gateSetup({ policy: [policy({ agent_access_enabled: false })] });
		expect(
			await refusedWith(requireApplyAuthorization(fake.db, { kind: "actor", actor: AGENT }, "deploy", TARGET, APPROVAL)),
		).toBe("not_permitted");
		expect(fake.writes).toHaveLength(0);
	});
});

describe("deciding an in-product agent's request", () => {
	const NOW = new Date();

	/** The executor one decision reads through. */
	function decideSetup(differentApprover: boolean) {
		return fakeExecutor(
			new Map<unknown, unknown[][]>([
				[applyApprovals, [[approvalRow()]]],
				[jobs, currentPlan()],
				[orgAgentPolicy, [[policy({ require_different_approver: differentApprover })]]],
				[projectEnvironments, [[{ stage: "staging", name: "staging" }]]],
			]),
			new Map<unknown, unknown[][]>([[applyApprovals, [[approvalRow({ status: "approved" })]]]]),
		);
	}

	/** A decider in a fresh console session. */
	const decider = (actor: Actor) => ({
		actor,
		sessionId: "00000000-0000-4000-8000-0000000000ee",
		sessionCreatedAt: new Date(NOW.getTime() - 60_000),
	});

	/** The ApprovalError code a decision rejects with. */
	async function codeOf(p: Promise<unknown>): Promise<string> {
		const err = await p.then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof ApprovalError)) throw new Error(`expected an ApprovalError, got ${String(err)}`);
		return err.code;
	}

	it("the agent cannot decide its own request", async () => {
		const fake = decideSetup(false);
		expect(await codeOf(decideApproval(fake.db, decider(AGENT), APPROVAL, { decision: "approve" }, NOW))).toBe("not_a_person");
	});

	it("the requester's own person is refused when the org requires a different approver", async () => {
		const fake = decideSetup(true);
		expect(await codeOf(decideApproval(fake.db, decider(PERSON), APPROVAL, { decision: "approve" }, NOW))).toBe(
			"self_approval",
		);
	});

	it("another person may approve it when the org requires a different approver", async () => {
		const fake = decideSetup(true);
		const other: Actor = { userId: OTHER_PERSON, orgId: ORG, credential: "session" };
		await expect(decideApproval(fake.db, decider(other), APPROVAL, { decision: "approve" }, NOW)).resolves.toMatchObject({
			ok: true,
		});
	});

	it("the requester's own person may approve it when the org does not require a different approver", async () => {
		const fake = decideSetup(false);
		await expect(decideApproval(fake.db, decider(PERSON), APPROVAL, { decision: "approve" }, NOW)).resolves.toMatchObject({
			ok: true,
		});
	});
});

describe("an answer that requested an approval", () => {
	/** An assistant answer holding one `request_apply` call with `output`. */
	const answerWith = (output: unknown) => ({
		id: "a1",
		role: "assistant" as const,
		parts: [
			{ type: "step-start" as const },
			{
				type: "tool-request_apply" as const,
				toolCallId: "t1",
				state: "output-available" as const,
				input: { plan_job_id: PLAN },
				output,
			},
		],
	});

	it("is not regenerated away: it holds the only card that decides and starts the request", () => {
		expect(hasAcceptedApproval(answerWith({ status: "requested", approval_id: APPROVAL }))).toBe(true);
	});

	it("a refused request leaves nothing to keep", () => {
		expect(hasAcceptedApproval(answerWith({ status: "refused", code: "not_permitted", reason: "off" }))).toBe(false);
	});
});
