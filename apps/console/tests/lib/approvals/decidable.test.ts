// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Approving re-checks the org's agent policy at decision time (AGT-L2, G14): the pure answer
// (`approveBlock`), the read the decision sheet uses (`readApproveBlock`), and `decideApproval`
// refusing a blocked approve with `policy_refused` while a deny still goes through.

import { beforeEach, describe, expect, it, vi } from "vitest";

const can = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can }) }));
const enterprise = vi.hoisted((): EnterpriseSlot => ({ current: null }));
vi.mock("@/lib/approvals/enterprise-policy", () => ({ enterpriseAgentPolicy: async () => enterprise.current }));

import type { AgentPolicy } from "@/lib/approvals/context";
import { approveBlock, readApproveBlock, resolveApproveBlock } from "@/lib/approvals/decidable";
import { decideApproval } from "@/lib/approvals/decide";
import { ApprovalError } from "@/lib/approvals/refusal";
import type { CredentialKind } from "@/lib/authz/types";
import { applyApprovals, jobs, orgAgentPolicy, projectEnvironments } from "@/lib/db/schema";
import { type EnterpriseSlot, fakeEnterprisePolicy } from "./fake-enterprise-policy";
import { fakeExecutor } from "./fake-executor";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const REQUESTER = "00000000-0000-4000-8000-000000000001";
const APPROVER = "00000000-0000-4000-8000-000000000002";
const DIGEST = "ab".repeat(32);
const NOW = new Date("2026-11-24T12:00:00Z");

const POLICY: AgentPolicy = {
	agentAccessEnabled: true,
	agentsMayNotApplyToProduction: false,
	requireDifferentApprover: false,
	allowedOauthClientIds: null,
	approvalTtlMinutes: 60,
};

const input = (over: Partial<Parameters<typeof approveBlock>[0]> = {}) => ({
	credential: "agent_oauth" as CredentialKind,
	operation: "deploy" as const,
	stage: "staging" as const,
	policy: POLICY,
	...over,
});

describe("approveBlock", () => {
	it("lets an ordinary agent request be approved", () => {
		expect(approveBlock(input())).toBeNull();
	});

	it.each(["agent_oauth", "agent_in_app"] as const)("blocks %s while agent access is off", (credential) => {
		const block = approveBlock(input({ credential, policy: { ...POLICY, agentAccessEnabled: false } }));
		expect(block?.reason).toBe("agent_access_disabled");
		expect(block?.message).toMatch(/turned off/);
	});

	it.each(["deploy", "destroy"] as const)("blocks an agent's production %s when agents are kept off production", (operation) => {
		const block = approveBlock(
			input({ operation, stage: "production", policy: { ...POLICY, agentsMayNotApplyToProduction: true } }),
		);
		expect(block?.reason).toBe("agents_not_on_production");
	});

	it("keeps a staging request approvable when agents are kept off production", () => {
		expect(approveBlock(input({ policy: { ...POLICY, agentsMayNotApplyToProduction: true } }))).toBeNull();
	});

	it.each(["cli_session", "service_token", "session"] as const)(
		"leaves a %s request to the approval as usual: the agent toggles bind agents only",
		(credential) => {
			const policy = { ...POLICY, agentAccessEnabled: false, agentsMayNotApplyToProduction: true };
			expect(approveBlock(input({ credential, stage: "production", policy }))).toBeNull();
		},
	);

	it("leaves the different-approver rule to the enterprise policy: core never reads the toggle", () => {
		expect(approveBlock(input({ policy: { ...POLICY, requireDifferentApprover: true } }))).toBeNull();
	});
});

describe("resolveApproveBlock with the enterprise policy", () => {
	const approval = {
		org_id: ORG,
		operation: "deploy" as const,
		requester_credential: "agent_oauth" as const,
		requester_credential_ref: "https://cursor.com/c.json",
		requester_user_id: REQUESTER,
	};
	const facts = (policy: AgentPolicy, deciderUserId = APPROVER) => ({ policy, stage: "staging" as const, deciderUserId });

	it("answers core alone when no enterprise policy is registered", async () => {
		expect(await resolveApproveBlock(approval, facts({ ...POLICY, requireDifferentApprover: true }, REQUESTER), null)).toBeNull();
	});

	it("blocks an app the allow-list leaves out", async () => {
		const policy = { ...POLICY, allowedOauthClientIds: ["https://claude.ai/c.json"] };
		const block = await resolveApproveBlock(approval, facts(policy), fakeEnterprisePolicy(true).policy);
		expect(block?.reason).toBe("client_not_allowed");
	});

	it("asks the allow-list only for an OAuth client's request", async () => {
		const fake = fakeEnterprisePolicy(true);
		const policy = { ...POLICY, allowedOauthClientIds: [] };
		expect(await resolveApproveBlock({ ...approval, requester_credential: "cli_session", requester_credential_ref: null }, facts(policy), fake.policy)).toBeNull();
		expect(fake.oauthClientRefusal).not.toHaveBeenCalled();
	});

	it("asks for a different person when the entitled org requires one", async () => {
		const policy = { ...POLICY, requireDifferentApprover: true };
		const fake = fakeEnterprisePolicy(true);
		expect((await resolveApproveBlock(approval, facts(policy, REQUESTER), fake.policy))?.reason).toBe("self_approval");
		expect(await resolveApproveBlock(approval, facts(policy), fake.policy)).toBeNull();
		expect(await resolveApproveBlock(approval, facts(policy, REQUESTER), fakeEnterprisePolicy(false).policy)).toBeNull();
	});

	it("names the core policy reason first", async () => {
		const policy = { ...POLICY, agentAccessEnabled: false, requireDifferentApprover: true };
		const block = await resolveApproveBlock(approval, facts(policy, REQUESTER), fakeEnterprisePolicy(true).policy);
		expect(block?.reason).toBe("agent_access_disabled");
	});
});

describe("readApproveBlock", () => {
	const approval = {
		org_id: ORG,
		project_id: "project",
		environment_id: "env",
		operation: "deploy" as const,
		requester_credential: "agent_oauth" as const,
		requester_credential_ref: null,
		requester_user_id: REQUESTER,
	};

	it("reads the org's policy and the environment's stage", async () => {
		const fake = fakeExecutor(
			new Map<unknown, unknown[][]>([
				[orgAgentPolicy, [[{ agent_access_enabled: true, agents_may_not_apply_to_production: true, require_different_approver: false, approval_ttl_minutes: 60 }]]],
				[projectEnvironments, [[{ stage: "production", name: "prod" }]]],
			]),
		);
		expect((await readApproveBlock(fake.db, approval, APPROVER))?.reason).toBe("agents_not_on_production");
	});

	it("reads a missing policy row as the defaults", async () => {
		const fake = fakeExecutor(new Map<unknown, unknown[][]>([[projectEnvironments, [[{ stage: "production", name: "prod" }]]]]));
		expect(await readApproveBlock(fake.db, approval, APPROVER)).toBeNull();
	});

	it("treats an environment it cannot read as production", async () => {
		const fake = fakeExecutor(
			new Map<unknown, unknown[][]>([
				[orgAgentPolicy, [[{ agent_access_enabled: true, agents_may_not_apply_to_production: true, require_different_approver: false, approval_ttl_minutes: 60 }]]],
			]),
		);
		expect((await readApproveBlock(fake.db, approval, APPROVER))?.reason).toBe("agents_not_on_production");
	});
});

describe("decideApproval re-checks the policy", () => {
	beforeEach(() => {
		enterprise.current = null;
		can.mockReset();
		can.mockResolvedValue({ allowed: true });
	});

	const decider = {
		actor: { userId: APPROVER, orgId: ORG, credential: "session" as const },
		sessionId: "00000000-0000-4000-8000-0000000000ee",
		sessionCreatedAt: new Date(NOW.getTime() - 60_000),
	};
	const row = {
		id: "00000000-0000-4000-8000-000000000050",
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
	};
	const killSwitchOff = () =>
		fakeExecutor(
			new Map<unknown, unknown[][]>([
				[applyApprovals, [[row]]],
				[jobs, [[{ status: "SUCCESS", created_at: NOW, plan_sha256: DIGEST, execution_metadata: null }], [], []]],
				[orgAgentPolicy, [[{ agent_access_enabled: false, agents_may_not_apply_to_production: false, require_different_approver: false, approval_ttl_minutes: 60 }]]],
				[projectEnvironments, [[{ stage: "staging", name: "staging" }]]],
			]),
			new Map<unknown, unknown[][]>([[applyApprovals, [[{ ...row, status: "rejected" }]]]]),
		);

	it("refuses an approve with policy_refused and writes nothing", async () => {
		const fake = killSwitchOff();
		const err = await decideApproval(fake.db, decider, row.id, { decision: "approve" }, NOW).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApprovalError);
		expect(err instanceof ApprovalError && err.code).toBe("policy_refused");
		expect(err instanceof ApprovalError && err.status).toBe(403);
		expect(fake.writes).toEqual([]);
	});

	it("still lets the same request be denied", async () => {
		const fake = killSwitchOff();
		const result = await decideApproval(fake.db, decider, row.id, { decision: "reject" }, NOW);
		expect(result.ok).toBe(true);
		expect(fake.writes).toHaveLength(1);
	});
});

describe("decideApproval and the enterprise allow-list", () => {
	it("refuses approving a request from an app the allow-list leaves out, with policy_refused", async () => {
		can.mockResolvedValue({ allowed: true });
		enterprise.current = fakeEnterprisePolicy(true).policy;
		const row = {
			id: "00000000-0000-4000-8000-000000000051",
			org_id: ORG,
			project_id: "project",
			environment_id: "env",
			operation: "deploy",
			plan_job_id: "plan",
			plan_sha256: DIGEST,
			requester_user_id: REQUESTER,
			requester_credential: "agent_oauth",
			requester_credential_ref: "https://cursor.com/c.json",
			status: "pending",
			expires_at: new Date(NOW.getTime() + 30 * 60_000),
		};
		const fake = fakeExecutor(
			new Map<unknown, unknown[][]>([
				[applyApprovals, [[row]]],
				[jobs, [[{ status: "SUCCESS", created_at: NOW, plan_sha256: DIGEST, execution_metadata: null }], [], []]],
				[orgAgentPolicy, [[{ agent_access_enabled: true, agents_may_not_apply_to_production: false, require_different_approver: false, approval_ttl_minutes: 60, allowed_oauth_client_ids: ["https://claude.ai/c.json"] }]]],
				[projectEnvironments, [[{ stage: "staging", name: "staging" }]]],
			]),
		);
		const decider = {
			actor: { userId: APPROVER, orgId: ORG, credential: "session" as const },
			sessionId: "00000000-0000-4000-8000-0000000000ee",
			sessionCreatedAt: new Date(NOW.getTime() - 60_000),
		};
		const err = await decideApproval(fake.db, decider, row.id, { decision: "approve" }, NOW).catch((e: unknown) => e);
		expect(err instanceof ApprovalError && err.code).toBe("policy_refused");
		expect(fake.writes).toEqual([]);
		enterprise.current = null;
	});
});
