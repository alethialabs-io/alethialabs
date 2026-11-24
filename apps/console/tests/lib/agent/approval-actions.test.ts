// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Starting an approved request from the approval card (lib/agent/approval-actions.ts): a person's
// click in the console queues the job as the credential that requested it — the in-product agent of
// that conversation — with the approval presented, so the queue gate decides it. Only the requester's
// own person starts it, and never a tool inside a turn.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeExecutor, type FakeExecutor } from "../approvals/fake-executor";

const currentActor = vi.fn();
vi.mock("@/lib/authz/guard", () => ({ currentActor: () => currentActor() }));
const scoped: { db: FakeExecutor["db"] | null } = { db: null };
vi.mock("@/lib/db", () => ({
	withActorScope: (_actor: unknown, fn: (tx: unknown) => Promise<unknown>) => {
		if (!scoped.db) throw new Error("no scoped executor set for this test");
		return fn(scoped.db);
	},
}));
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

import { startInAppApproval } from "@/lib/agent/approval-actions";
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
