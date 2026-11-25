// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Reading an approval for the card, and starting an approved request from it
// (lib/agent/approval-actions.ts). The card's facts come from the plan job, never the agent. A person's
// click in the console queues the job as the credential that requested it — the in-product agent of
// that conversation — with the approval presented, so the queue gate decides it. Only the requester's
// own person starts it, and never a tool inside a turn.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeExecutor } from "../approvals/fake-executor";

const currentActor = vi.fn();
vi.mock("@/lib/authz/guard", () => ({ currentActor: () => currentActor() }));
const scoped: { db: unknown } = { db: null };
vi.mock("@/lib/db", () => ({
	withActorScope: (_actor: unknown, fn: (tx: unknown) => Promise<unknown>) => {
		if (!scoped.db) throw new Error("no scoped executor set for this test");
		return fn(scoped.db);
	},
}));
const readApproval = vi.fn();
vi.mock("@/lib/approvals/read", () => ({ readApproval: (...args: unknown[]) => readApproval(...args) }));
/** What each queueing action was called with, and the actor it ran as. */
const queued: { action: string; args: unknown[]; actor: unknown }[] = [];
const queueResult: { value: { ok: true; jobId: string; jobs: never[] } | { ok: false; error: string } } = {
	value: { ok: true, jobId: "job-1", jobs: [] },
};
vi.mock("@/app/server/actions/projects", async () => {
	const { getInjectedActor } = await import("@/lib/authz/actor-context");
	const record = (action: string) => async (...args: unknown[]) => {
		queued.push({ action, args, actor: getInjectedActor() });
		return queueResult.value;
	};
	return { tryProvisionProject: record("deploy"), tryDestroyProject: record("destroy") };
});

import { readInAppApproval, startInAppApproval } from "@/lib/agent/approval-actions";
import { ApprovalError } from "@/lib/approvals/refusal";
import { inAppAgentActor } from "@/lib/agent/in-app-credential";
import type { Actor } from "@/lib/authz/types";
import { applyApprovals } from "@/lib/db/schema";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000010";
const ENV = "00000000-0000-4000-8000-000000000020";
const PLAN = "00000000-0000-4000-8000-000000000030";
const APPROVAL = "00000000-0000-4000-8000-000000000050";
const THREAD = "00000000-0000-4000-8000-000000000070";

const PERSON: Actor = { userId: USER, orgId: ORG, credential: "session" };

/** The approval row the action reads, with `overrides`. */
function row(overrides: Record<string, unknown> = {}) {
	return {
		id: APPROVAL,
		operation: "deploy",
		project_id: PROJECT,
		environment_id: ENV,
		plan_job_id: PLAN,
		requester_user_id: USER,
		requester_credential: "agent_in_app",
		requester_credential_ref: THREAD,
		...overrides,
	};
}

/** Answers the action's one read with `rows`. */
function reads(rows: unknown[]) {
	scoped.db = fakeExecutor(new Map<unknown, unknown[][]>([[applyApprovals, [rows]]])).db;
}

beforeEach(() => {
	queued.length = 0;
	queueResult.value = { ok: true, jobId: "job-1", jobs: [] };
	currentActor.mockReset();
	currentActor.mockResolvedValue(PERSON);
	scoped.db = null;
	readApproval.mockReset();
});

describe("startInAppApproval", () => {
	it("queues the deploy as the conversation's in-product agent, presenting the approval and its plan", async () => {
		reads([row()]);
		await expect(startInAppApproval({ approvalId: APPROVAL })).resolves.toEqual({ ok: true, data: { jobId: "job-1" } });
		expect(queued).toEqual([
			{
				action: "deploy",
				args: [PROJECT, PLAN, undefined, ENV, undefined, APPROVAL],
				actor: inAppAgentActor(PERSON, THREAD),
			},
		]);
	});

	it("queues a destroy with the approval presented", async () => {
		reads([row({ operation: "destroy" })]);
		await expect(startInAppApproval({ approvalId: APPROVAL })).resolves.toMatchObject({ ok: true });
		expect(queued).toEqual([
			{ action: "destroy", args: [PROJECT, ENV, undefined, { approvalId: APPROVAL }], actor: inAppAgentActor(PERSON, THREAD) },
		]);
	});

	it("answers the queue gate's refusal as the card's message", async () => {
		reads([row()]);
		queueResult.value = { ok: false, error: "That approval was already used. Each approval queues one job." };
		await expect(startInAppApproval({ approvalId: APPROVAL })).resolves.toEqual({
			ok: false,
			error: { kind: "conflict", message: "That approval was already used. Each approval queues one job." },
		});
	});

	it("is refused to a tool inside a turn: only a person in the console starts a job", async () => {
		currentActor.mockResolvedValue(inAppAgentActor(PERSON, THREAD));
		reads([row()]);
		await expect(startInAppApproval({ approvalId: APPROVAL })).resolves.toMatchObject({ ok: false, error: { kind: "conflict" } });
		expect(queued).toHaveLength(0);
	});

	it.each([
		["another person's request", { requester_user_id: "00000000-0000-4000-8000-000000000002" }],
		["a connected agent's request", { requester_credential: "agent_oauth", requester_credential_ref: "client-1" }],
		["a CLI login's request", { requester_credential: "cli_session", requester_credential_ref: null }],
	])("is refused for %s", async (_name, overrides) => {
		reads([row(overrides)]);
		await expect(startInAppApproval({ approvalId: APPROVAL })).resolves.toMatchObject({ ok: false, error: { kind: "conflict" } });
		expect(queued).toHaveLength(0);
	});

	it("answers not-found for an approval outside the reader's org", async () => {
		reads([]);
		await expect(startInAppApproval({ approvalId: APPROVAL })).resolves.toMatchObject({ ok: false, error: { kind: "not-found" } });
		expect(queued).toHaveLength(0);
	});
});

/** One Terraform resource change with `actions`. */
function change(address: string, actions: string[]) {
	return { address, type: "aws_instance", name: address, change: { actions, after: {}, after_unknown: {} } };
}

const VIEW = { id: APPROVAL, status: "pending", operation: "deploy", project_id: PROJECT };

/** Answers the card read's one joined SELECT with `rows`. */
function joinedRead(rows: unknown[]) {
	const chain = {
		from: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(rows),
	};
	scoped.db = { select: () => chain };
}

/** The joined row the card read answers, with `overrides`. */
function joined(overrides: Record<string, unknown> = {}) {
	return {
		reason: "initial staging cluster",
		requester_user_id: USER,
		requester_credential: "agent_in_app",
		execution_metadata: {
			plan_result: {
				resource_changes: [
					change("a", ["create"]),
					change("b", ["create"]),
					change("c", ["update"]),
					change("d", ["delete", "create"]),
					change("e", ["delete"]),
					change("f", ["no-op"]),
				],
			},
			cost_breakdown: { totalMonthlyCost: "61.20" },
			verify_result: { verdict: "pass" },
		},
		project_name: "acme",
		environment_name: "staging",
		...overrides,
	};
}

describe("readInAppApproval", () => {
	it("answers the approval with its plan job's own counts, cost and verdict", async () => {
		readApproval.mockResolvedValue(VIEW);
		joinedRead([joined()]);
		await expect(readInAppApproval({ approvalId: APPROVAL })).resolves.toEqual({
			ok: true,
			data: {
				approval: VIEW,
				plan: {
					projectName: "acme",
					environmentName: "staging",
					add: 2,
					change: 2,
					destroy: 1,
					monthly: 61.2,
					verifyVerdict: "pass",
				},
				reason: "initial staging cluster",
				requestedByReader: true,
			},
		});
		expect(readApproval).toHaveBeenCalledWith(expect.anything(), PERSON, APPROVAL);
	});

	it("leaves the facts empty when the plan job stored no plan output or cost", async () => {
		readApproval.mockResolvedValue(VIEW);
		joinedRead([
			joined({
				execution_metadata: {},
				project_name: null,
				environment_name: null,
			}),
		]);
		const res = await readInAppApproval({ approvalId: APPROVAL });
		expect(res).toMatchObject({
			ok: true,
			data: {
				plan: {
					projectName: null,
					environmentName: null,
					add: null,
					change: null,
					destroy: null,
					monthly: null,
					verifyVerdict: null,
				},
			},
		});
	});

	it("tells a reader who did not ask the assistant that they cannot start it", async () => {
		readApproval.mockResolvedValue(VIEW);
		joinedRead([joined({ requester_user_id: "00000000-0000-4000-8000-000000000002", execution_metadata: null })]);
		await expect(readInAppApproval({ approvalId: APPROVAL })).resolves.toMatchObject({
			ok: true,
			data: { requestedByReader: false },
		});
	});

	it("answers not-found when the engine cannot see the approval", async () => {
		readApproval.mockRejectedValue(new ApprovalError("not_found", "That approval was not found."));
		joinedRead([]);
		await expect(readInAppApproval({ approvalId: APPROVAL })).resolves.toEqual({
			ok: false,
			error: { kind: "not-found", message: "That approval was not found." },
		});
	});

	it("answers not-found when the approval row is gone after the engine read it", async () => {
		readApproval.mockResolvedValue(VIEW);
		joinedRead([]);
		await expect(readInAppApproval({ approvalId: APPROVAL })).resolves.toMatchObject({
			ok: false,
			error: { kind: "not-found" },
		});
	});
});
