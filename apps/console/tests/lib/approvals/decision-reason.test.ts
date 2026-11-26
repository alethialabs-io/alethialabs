// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Deny with an optional reason (AGT-L2, G3): the reason is stored on a reject, trimmed and capped,
// never on an approve, and the approval read returns it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const can = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can }) }));

import { DECISION_REASON_MAX } from "@/lib/approvals/decidable";
import { decideApproval, decisionReasonOf } from "@/lib/approvals/decide";
import { viewOf } from "@/lib/approvals/read";
import type { ApplyApproval } from "@/lib/db/schema/agent-surface";
import { applyApprovals, jobs, orgAgentPolicy, projectEnvironments } from "@/lib/db/schema";
import { fakeExecutor } from "./fake-executor";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const DIGEST = "ab".repeat(32);
const NOW = new Date("2026-11-24T12:00:00Z");

describe("decisionReasonOf", () => {
	it("keeps a trimmed reason on a reject", () => {
		expect(decisionReasonOf({ decision: "reject", reason: "  wrong environment  " })).toBe("wrong environment");
	});

	it("stores nothing for an empty or absent reason", () => {
		expect(decisionReasonOf({ decision: "reject", reason: "   " })).toBeNull();
		expect(decisionReasonOf({ decision: "reject" })).toBeNull();
	});

	it("never stores a reason on an approve", () => {
		expect(decisionReasonOf({ decision: "approve", reason: "looks fine" })).toBeNull();
	});

	it("caps the reason at the column's limit", () => {
		expect(decisionReasonOf({ decision: "reject", reason: "x".repeat(900) })).toHaveLength(DECISION_REASON_MAX);
	});
});

describe("decideApproval writes the reason", () => {
	beforeEach(() => {
		can.mockReset();
		can.mockResolvedValue({ allowed: true });
	});

	it("records the deny reason on the row", async () => {
		const row = {
			id: "00000000-0000-4000-8000-000000000050",
			org_id: ORG,
			project_id: "project",
			environment_id: "env",
			operation: "deploy",
			plan_job_id: "plan",
			plan_sha256: DIGEST,
			requester_user_id: "00000000-0000-4000-8000-000000000001",
			requester_credential: "cli_session",
			status: "pending",
			expires_at: new Date(NOW.getTime() + 30 * 60_000),
		};
		const fake = fakeExecutor(
			new Map<unknown, unknown[][]>([
				[applyApprovals, [[row]]],
				[jobs, [[{ status: "SUCCESS", created_at: NOW, plan_sha256: DIGEST, execution_metadata: null, destroy_plan: false }], [], []]],
				[orgAgentPolicy, [[]]],
				[projectEnvironments, [[{ stage: "staging", name: "staging" }]]],
			]),
			new Map<unknown, unknown[][]>([[applyApprovals, [[{ ...row, status: "rejected" }]]]]),
		);
		const decider = {
			actor: { userId: "00000000-0000-4000-8000-000000000002", orgId: ORG, credential: "session" as const },
			sessionId: "00000000-0000-4000-8000-0000000000ee",
			sessionCreatedAt: new Date(NOW.getTime() - 60_000),
		};
		await decideApproval(fake.db, decider, row.id, { decision: "reject", reason: " not this week " }, NOW);
		expect(fake.writes).toHaveLength(1);
		expect(fake.writes[0]?.values).toMatchObject({ status: "rejected", decision_reason: "not this week" });
	});
});

describe("viewOf", () => {
	it("returns the decision reason", async () => {
		const approval: ApplyApproval = {
			id: "00000000-0000-4000-8000-000000000050",
			org_id: ORG,
			project_id: "project",
			environment_id: "env",
			operation: "deploy",
			plan_job_id: "plan",
			plan_sha256: DIGEST,
			config_hash: null,
			requester_user_id: "u",
			requester_credential: "agent_oauth",
			requester_credential_ref: null,
			reason: null,
			status: "rejected",
			approver_user_id: "a",
			approver_session_id: null,
			decided_at: NOW,
			decision_reason: "not this week",
			expires_at: new Date(NOW.getTime() + 60_000),
			consumed_at: null,
			consumed_job_id: null,
			created_at: NOW,
			updated_at: NOW,
		};
		const view = await viewOf(fakeExecutor().db, approval, NOW);
		expect(view.decision_reason).toBe("not this week");
		expect(view.status).toBe("rejected");
	});
});
