// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The queue gate (lib/approvals/gate.ts, behind `requireApplyAuthorization`): what it allows, what it
// refuses, and that a consumed approval is bound to the org, project, environment, operation,
// requesting credential and plan digest, and used once. The engine is real; the executor is a fake
// answering each table's reads (fake-executor.ts). The single-use compare-and-set against real
// Postgres is the database's (`uq_jobs_approval_id`, the CAS WHERE), exercised in CI's integration tier.

import { beforeEach, describe, expect, it, vi } from "vitest";

const enterprise = vi.hoisted((): EnterpriseSlot => ({ current: null }));
vi.mock("@/lib/approvals/enterprise-policy", () => ({ enterpriseAgentPolicy: async () => enterprise.current }));

import { ApplyAuthorizationError, type ApplyTarget, requireApplyAuthorization, SYSTEM_APPLY_ORIGINS } from "@/lib/approvals/types";
import type { Actor, CredentialKind } from "@/lib/authz/types";
import { applyApprovals, cliServiceTokens, jobs, orgAgentPolicy, projectEnvironments } from "@/lib/db/schema";
import { type EnterpriseSlot, fakeEnterprisePolicy } from "./fake-enterprise-policy";
import { fakeExecutor, untouchableTx } from "./fake-executor";

beforeEach(() => {
	enterprise.current = null;
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000bb";
const USER = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000010";
const ENV = "00000000-0000-4000-8000-000000000020";
const PLAN = "00000000-0000-4000-8000-000000000030";
const JOB = "00000000-0000-4000-8000-000000000040";
const APPROVAL = "00000000-0000-4000-8000-000000000050";
const TOKEN = "00000000-0000-4000-8000-000000000060";
const DIGEST = "ab".repeat(32);
const PLANNED_AT = new Date("2026-11-24T10:00:00Z");

const actorOf = (credential: CredentialKind, extra: Partial<Actor> = {}): Actor => ({
	userId: USER,
	orgId: ORG,
	credential,
	...(credential === "service_token" ? { credentialRef: TOKEN } : {}),
	...extra,
});

const DEPLOY_TARGET: ApplyTarget = { orgId: ORG, projectId: PROJECT, environmentId: ENV, jobId: JOB, planJobId: PLAN };
const DESTROY_TARGET: ApplyTarget = { orgId: ORG, projectId: PROJECT, environmentId: ENV, jobId: JOB };

/** An approved, unexpired approval row, as `select().from(applyApprovals)` answers it. */
function approvalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: APPROVAL,
		org_id: ORG,
		project_id: PROJECT,
		environment_id: ENV,
		operation: "deploy",
		plan_job_id: PLAN,
		plan_sha256: DIGEST,
		config_hash: null,
		requester_user_id: USER,
		requester_credential: "cli_session",
		requester_credential_ref: null,
		status: "approved",
		expires_at: new Date(Date.now() + 30 * 60_000),
		consumed_at: null,
		...overrides,
	};
}

interface Setup {
	stage?: "development" | "staging" | "production";
	policy?: Record<string, unknown>[];
	token?: Record<string, unknown>[];
	approval?: Record<string, unknown>[];
	/** The plan the deploy names, as the digest read and the binding read answer it. */
	plan?: Record<string, unknown>[];
	/** Something queued on the environment after the plan. */
	runSince?: boolean;
	newerPlan?: boolean;
	/** For a destroy: the latest successful DEPLOY. */
	applied?: Record<string, unknown>[];
	/** What the consume UPDATE … RETURNING answers. */
	cas?: unknown[];
}

/** A fake executor answering one gate call's reads, in the order the gate makes them. */
function setup(s: Setup = {}) {
	const plan = s.plan ?? [{ status: "SUCCESS", created_at: PLANNED_AT, plan_sha256: DIGEST, execution_metadata: null }];
	const jobReads: unknown[][] = s.applied
		? [s.applied, s.runSince ? [{ id: "later" }] : []]
		: [plan, plan, s.runSince ? [{ id: "later" }] : [], s.newerPlan ? [{ id: "newer" }] : []];
	return fakeExecutor(
		new Map<unknown, unknown[][]>([
			[projectEnvironments, [[{ stage: s.stage ?? "development", name: "dev" }]]],
			[orgAgentPolicy, [s.policy ?? []]],
			[cliServiceTokens, [s.token ?? []]],
			[applyApprovals, [s.approval ?? [approvalRow()]]],
			[jobs, jobReads],
		]),
		new Map<unknown, unknown[][]>([[applyApprovals, [s.cas ?? [{ id: APPROVAL }]]]]),
	);
}

/** The refusal a promise rejects with. */
async function refusal(p: Promise<unknown>): Promise<ApplyAuthorizationError> {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	if (!(err instanceof ApplyAuthorizationError)) throw new Error(`expected an ApplyAuthorizationError, got ${String(err)}`);
	return err;
}

describe("system origins", () => {
	const ORIGIN_OPERATION = { build_chain: "deploy", promotion: "deploy", auto_heal: "deploy", ephemeral_reap: "destroy" } as const;

	it.each(SYSTEM_APPLY_ORIGINS)("%s is allowed its own operation, with no approval and no read", async (origin) => {
		await expect(
			requireApplyAuthorization(untouchableTx(), { kind: "system", origin }, ORIGIN_OPERATION[origin], DESTROY_TARGET),
		).resolves.toEqual({ approvalId: null });
	});

	it.each(SYSTEM_APPLY_ORIGINS)("%s is refused the other operation", async (origin) => {
		const other = ORIGIN_OPERATION[origin] === "deploy" ? "destroy" : "deploy";
		const err = await refusal(requireApplyAuthorization(untouchableTx(), { kind: "system", origin }, other, DESTROY_TARGET));
		expect(err.code).toBe("not_permitted");
	});
});

describe("a person at the console", () => {
	it.each(["deploy", "destroy"] as const)("may %s with no approval, and nothing is read", async (operation) => {
		await expect(
			requireApplyAuthorization(untouchableTx(), { kind: "actor", actor: actorOf("session") }, operation, DEPLOY_TARGET),
		).resolves.toEqual({ approvalId: null });
	});
});

describe("credentials that need an approval", () => {
	const NEEDS = ["cli_session", "agent_oauth", "agent_in_app", "service_token"] as const;

	it.each(NEEDS.flatMap((c) => (["deploy", "destroy"] as const).map((op) => [c, op] as const)))(
		"%s %s without an approval is refused with approval_required and nothing is consumed",
		async (credential, operation) => {
			const f = setup();
			const err = await refusal(
				requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf(credential) }, operation, DEPLOY_TARGET),
			);
			expect(err.code).toBe("approval_required");
			expect(f.writes).toEqual([]);
		},
	);

	it.each(NEEDS)("%s deploy with its approved approval consumes it and stamps the job", async (credential) => {
		const f = setup({
			approval: [
				approvalRow({
					requester_credential: credential,
					requester_credential_ref: credential === "service_token" ? TOKEN : null,
				}),
			],
		});
		await expect(
			requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf(credential) }, "deploy", DEPLOY_TARGET, APPROVAL),
		).resolves.toEqual({ approvalId: APPROVAL });
		expect(f.writes.map((w) => [w.table, w.values])).toEqual([
			[applyApprovals, expect.objectContaining({ status: "consumed", consumed_job_id: JOB })],
			[jobs, { approval_id: APPROVAL }],
		]);
	});
});

describe("an approval is bound and single-use", () => {
	const cli = { kind: "actor" as const, actor: actorOf("cli_session") };

	const CASES: Array<[string, Setup, ApplyTarget, string]> = [
		["another org's approval", { approval: [approvalRow({ org_id: OTHER_ORG })] }, DEPLOY_TARGET, "approval_invalid"],
		["an approval of another environment", { approval: [approvalRow({ environment_id: "x" })] }, DEPLOY_TARGET, "approval_invalid"],
		["a destroy approval presented for a deploy", { approval: [approvalRow({ operation: "destroy" })] }, DEPLOY_TARGET, "approval_invalid"],
		["an approval requested by another credential kind", { approval: [approvalRow({ requester_credential: "agent_oauth" })] }, DEPLOY_TARGET, "approval_invalid"],
		["an approval requested by another person", { approval: [approvalRow({ requester_user_id: "someone" })] }, DEPLOY_TARGET, "approval_invalid"],
		["an approval of a different plan", {}, { ...DEPLOY_TARGET, planJobId: "other-plan" }, "approval_invalid"],
		["a deploy that names no plan (a build)", {}, { ...DEPLOY_TARGET, planJobId: undefined }, "approval_invalid"],
		[
			"an approval whose digest is not the plan's",
			{ plan: [{ status: "SUCCESS", created_at: PLANNED_AT, plan_sha256: "cd".repeat(32), execution_metadata: null }] },
			DEPLOY_TARGET,
			"approval_invalid",
		],
		["an approval after something ran since the plan", { runSince: true }, DEPLOY_TARGET, "approval_invalid"],
		["an approval after a newer plan succeeded", { newerPlan: true }, DEPLOY_TARGET, "approval_invalid"],
		["a pending approval", { approval: [approvalRow({ status: "pending" })] }, DEPLOY_TARGET, "approval_required"],
		["a rejected approval", { approval: [approvalRow({ status: "rejected" })] }, DEPLOY_TARGET, "approval_invalid"],
		["an expired approval", { approval: [approvalRow({ status: "expired" })] }, DEPLOY_TARGET, "approval_invalid"],
		["a superseded approval", { approval: [approvalRow({ status: "superseded" })] }, DEPLOY_TARGET, "approval_invalid"],
		["a consumed approval", { approval: [approvalRow({ status: "consumed" })] }, DEPLOY_TARGET, "approval_invalid"],
		["an approval that lost the consume race or expired", { cas: [] }, DEPLOY_TARGET, "approval_invalid"],
		["an unknown approval", { approval: [] }, DEPLOY_TARGET, "approval_invalid"],
	];

	it.each(CASES)("refuses %s", async (_name, s, target, code) => {
		const f = setup(s);
		const err = await refusal(requireApplyAuthorization(f.db, cli, "deploy", target, APPROVAL));
		expect(err.code).toBe(code);
		// Nothing but (at most) the failed compare-and-set was written; the job is never stamped.
		expect(f.writes.some((w) => w.table === jobs)).toBe(false);
	});

	it("a service token's approval does not serve another token of the same person", async () => {
		const f = setup({ approval: [approvalRow({ requester_credential: "service_token", requester_credential_ref: "another-token" })] });
		const err = await refusal(
			requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf("service_token") }, "deploy", DEPLOY_TARGET, APPROVAL),
		);
		expect(err.code).toBe("approval_invalid");
	});
});

describe("destroy", () => {
	const cli = { kind: "actor" as const, actor: actorOf("cli_session") };
	const destroyApproval = approvalRow({ operation: "destroy" });
	const applied = [{ id: "deploy-1", plan_job_id: PLAN, plan_sha256: DIGEST, created_at: PLANNED_AT }];

	it("consumes an approval bound to the environment's applied state", async () => {
		const f = setup({ approval: [destroyApproval], applied });
		await expect(requireApplyAuthorization(f.db, cli, "destroy", DESTROY_TARGET, APPROVAL)).resolves.toEqual({
			approvalId: APPROVAL,
		});
	});

	it("refuses it once the environment was deployed from another plan", async () => {
		const f = setup({ approval: [destroyApproval], applied: [{ ...applied[0], plan_job_id: "newer-plan" }] });
		expect((await refusal(requireApplyAuthorization(f.db, cli, "destroy", DESTROY_TARGET, APPROVAL))).code).toBe(
			"approval_invalid",
		);
	});

	it("refuses it once something else ran on the environment", async () => {
		const f = setup({ approval: [destroyApproval], applied, runSince: true });
		expect((await refusal(requireApplyAuthorization(f.db, cli, "destroy", DESTROY_TARGET, APPROVAL))).code).toBe(
			"approval_invalid",
		);
	});

	it("refuses a cascade to the environments on the Fabric for a credential that needs an approval", async () => {
		const f = setup({ approval: [destroyApproval], applied });
		const err = await refusal(
			requireApplyAuthorization(f.db, cli, "destroy", { ...DESTROY_TARGET, cascadeOfEnvironmentId: "owner-env" }, APPROVAL),
		);
		expect(err.code).toBe("approval_required");
		expect(f.writes).toEqual([]);
	});
});

describe("the org's agent policy", () => {
	it("refuses every agent apply when agent access is off", async () => {
		for (const credential of ["agent_oauth", "agent_in_app"] as const) {
			const f = setup({ policy: [{ agent_access_enabled: false, agents_may_not_apply_to_production: false, require_different_approver: false, approval_ttl_minutes: 60 }] });
			const err = await refusal(
				requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf(credential) }, "deploy", DEPLOY_TARGET, APPROVAL),
			);
			expect(err.code).toBe("not_permitted");
		}
	});

	it.each(["agent_oauth", "agent_in_app"] as const)(
		"an approval a person granted to %s BEFORE agent access was turned off cannot be used after it (#7477)",
		async (credential) => {
			const granted = [approvalRow({ requester_credential: credential, status: "approved" })];
			const off = { agent_access_enabled: false, agents_may_not_apply_to_production: false, require_different_approver: false, approval_ttl_minutes: 60 };
			const requester = { kind: "actor" as const, actor: actorOf(credential) };
			// The same row, switch on: it is a valid approval the gate consumes.
			const on = setup({ approval: granted });
			await expect(requireApplyAuthorization(on.db, requester, "deploy", DEPLOY_TARGET, APPROVAL)).resolves.toEqual({
				approvalId: APPROVAL,
			});
			// Switch off: refused, and the approval is neither consumed nor a job queued.
			const f = setup({ policy: [off], approval: granted });
			const err = await refusal(requireApplyAuthorization(f.db, requester, "deploy", DEPLOY_TARGET, APPROVAL));
			expect(err.code).toBe("not_permitted");
			expect(err.message).toContain("Agent access is turned off");
			expect(f.writes).toEqual([]);
		},
	);

	it("refuses an agent's production deploy outright when agents may not apply to production, approval or not", async () => {
		const f = setup({
			stage: "production",
			policy: [{ agent_access_enabled: true, agents_may_not_apply_to_production: true, require_different_approver: false, approval_ttl_minutes: 60 }],
			approval: [approvalRow({ requester_credential: "agent_oauth" })],
		});
		const err = await refusal(
			requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf("agent_oauth") }, "deploy", DEPLOY_TARGET, APPROVAL),
		);
		expect(err.code).toBe("not_permitted");
		expect(f.writes).toEqual([]);
	});
});

describe("a service token's automatic deploys (decision D2)", () => {
	const token = { kind: "actor" as const, actor: actorOf("service_token") };

	it("deploys a listed non-production environment with no approval", async () => {
		const f = setup({ token: [{ auto_approve_environment_ids: [ENV] }] });
		await expect(requireApplyAuthorization(f.db, token, "deploy", DEPLOY_TARGET)).resolves.toEqual({ approvalId: null });
		expect(f.writes).toEqual([]);
	});

	it("still needs an approval for a listed production environment", async () => {
		const f = setup({ stage: "production", token: [{ auto_approve_environment_ids: [ENV] }] });
		expect((await refusal(requireApplyAuthorization(f.db, token, "deploy", DEPLOY_TARGET))).code).toBe("approval_required");
	});

	it("still needs an approval to destroy a listed environment, and never reads the list for it", async () => {
		const f = setup({ token: [{ auto_approve_environment_ids: [ENV] }] });
		expect((await refusal(requireApplyAuthorization(f.db, token, "destroy", DESTROY_TARGET))).code).toBe("approval_required");
		expect(f.selects.get(cliServiceTokens)).toBeUndefined();
	});

	it("needs an approval when the token (revoked, or of another org) is not found", async () => {
		const f = setup({ token: [] });
		expect((await refusal(requireApplyAuthorization(f.db, token, "deploy", DEPLOY_TARGET))).code).toBe("approval_required");
	});
});

describe("tenancy", () => {
	it("refuses a target in another org than the actor's before reading anything", async () => {
		const err = await refusal(
			requireApplyAuthorization(
				untouchableTx(),
				{ kind: "actor", actor: actorOf("cli_session") },
				"deploy",
				{ ...DEPLOY_TARGET, orgId: OTHER_ORG },
				APPROVAL,
			),
		);
		expect(err.code).toBe("not_permitted");
	});
});

describe("each insert site's request, from a credential that needs an approval and presents none", () => {
	// The shapes app/server/actions/projects.ts hands the gate (tests/lib/approvals/apply-authorization.test.ts
	// proves each site asks): buildProject's BUILD that chains a deploy, provisionProject's DEPLOY of a
	// named plan, destroyProject's DESTROY of its target and of each cascaded tenant.
	const SITES: Array<[string, "deploy" | "destroy", ApplyTarget]> = [
		["buildProject", "deploy", { ...DEPLOY_TARGET, planJobId: undefined }],
		["provisionProject", "deploy", DEPLOY_TARGET],
		["destroyProject (target)", "destroy", DESTROY_TARGET],
		["destroyProject (cascaded tenant)", "destroy", { ...DESTROY_TARGET, cascadeOfEnvironmentId: "owner-env" }],
	];

	it.each(SITES)("%s is refused and writes nothing", async (_site, operation, target) => {
		for (const credential of ["cli_session", "agent_oauth", "agent_in_app", "service_token"] as const) {
			const f = setup();
			const err = await refusal(requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf(credential) }, operation, target));
			expect(err.code).toBe("approval_required");
			expect(f.writes).toEqual([]);
		}
	});
});

// AGT-L14: the enterprise agent policy, registered through enterprise-policy.ts. Without one (every
// case above) core answers alone; with one, the gate asks it, and acts on what it answers.
describe("the enterprise agent policy", () => {
	const session = { kind: "actor" as const, actor: actorOf("session") };
	const STORED_ON = [
		{
			agent_access_enabled: true,
			agents_may_not_apply_to_production: false,
			require_different_approver: true,
			approval_ttl_minutes: 60,
			allowed_oauth_client_ids: ["claude-code"],
		},
	];

	describe("require a different approver — a person's own click", () => {
		it("refuses a production deploy with no approval, and writes nothing", async () => {
			const fake = fakeEnterprisePolicy(true);
			enterprise.current = fake.policy;
			const f = setup({ stage: "production", policy: STORED_ON });
			const err = await refusal(requireApplyAuthorization(f.db, session, "deploy", DEPLOY_TARGET));
			expect(err.code).toBe("approval_required");
			expect(err.message).toMatch(/second person/);
			expect(fake.sessionApplyNeedsSecondPerson).toHaveBeenCalledWith(
				ORG,
				expect.objectContaining({ requireDifferentApprover: true, allowedOauthClientIds: ["claude-code"] }),
				"deploy",
				"production",
			);
			expect(f.writes).toEqual([]);
		});

		it("refuses a destroy of any stage with no approval", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			const f = setup({ stage: "development", policy: STORED_ON });
			expect((await refusal(requireApplyAuthorization(f.db, session, "destroy", DESTROY_TARGET))).code).toBe("approval_required");
		});

		it("leaves a staging deploy to the click", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			const f = setup({ stage: "staging", policy: STORED_ON });
			await expect(requireApplyAuthorization(f.db, session, "deploy", DEPLOY_TARGET)).resolves.toEqual({ approvalId: null });
		});

		it("leaves every click alone when the toggle is off", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			const f = setup({ stage: "production" });
			await expect(requireApplyAuthorization(f.db, session, "destroy", DESTROY_TARGET)).resolves.toEqual({ approvalId: null });
		});

		it("leaves every click alone when the organization is not entitled (unlicensed = core)", async () => {
			enterprise.current = fakeEnterprisePolicy(false).policy;
			const f = setup({ stage: "production", policy: STORED_ON });
			await expect(requireApplyAuthorization(f.db, session, "deploy", DEPLOY_TARGET)).resolves.toEqual({ approvalId: null });
		});

		it("consumes the person's approval when a different person approved it", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			const f = setup({
				stage: "production",
				policy: STORED_ON,
				approval: [approvalRow({ requester_credential: "session", approver_user_id: "someone-else" })],
			});
			await expect(requireApplyAuthorization(f.db, session, "deploy", DEPLOY_TARGET, APPROVAL)).resolves.toEqual({
				approvalId: APPROVAL,
			});
		});

		it("refuses an approval its requester approved (decided before the toggle was on), and stamps nothing", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			const f = setup({
				stage: "production",
				policy: STORED_ON,
				approval: [approvalRow({ requester_credential: "session", approver_user_id: USER })],
			});
			const err = await refusal(requireApplyAuthorization(f.db, session, "deploy", DEPLOY_TARGET, APPROVAL));
			expect(err.code).toBe("approval_invalid");
			expect(f.writes).toEqual([]);
		});

		it("holds an agent's self-approved approval to the same rule", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			const f = setup({
				policy: STORED_ON,
				approval: [approvalRow({ requester_credential: "cli_session", approver_user_id: USER })],
			});
			const err = await refusal(
				requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf("cli_session") }, "deploy", DEPLOY_TARGET, APPROVAL),
			);
			expect(err.code).toBe("approval_invalid");
		});

		it("covers the environments on a Fabric by the Fabric's own approval, with nothing read for them", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			await expect(
				requireApplyAuthorization(
					untouchableTx(),
					session,
					"destroy",
					{ ...DESTROY_TARGET, cascadeOfEnvironmentId: "owner-env" },
					APPROVAL,
				),
			).resolves.toEqual({ approvalId: null });
		});
	});

	describe("the OAuth client allow-list", () => {
		const oauth = (clientId?: string) => ({
			kind: "actor" as const,
			actor: actorOf("agent_oauth", clientId === undefined ? {} : { credentialRef: clientId }),
		});

		it("refuses a client outside the list, approval or not, and writes nothing", async () => {
			const fake = fakeEnterprisePolicy(true);
			enterprise.current = fake.policy;
			const f = setup({ policy: STORED_ON, approval: [approvalRow({ requester_credential: "agent_oauth", requester_credential_ref: "cursor" })] });
			const err = await refusal(requireApplyAuthorization(f.db, oauth("cursor"), "deploy", DEPLOY_TARGET, APPROVAL));
			expect(err.code).toBe("not_permitted");
			expect(fake.oauthClientRefusal).toHaveBeenCalledWith(ORG, expect.objectContaining({ allowedOauthClientIds: ["claude-code"] }), "cursor");
			expect(f.writes).toEqual([]);
		});

		it("refuses a token that names no client when a list is set", async () => {
			const fake = fakeEnterprisePolicy(true);
			enterprise.current = fake.policy;
			const f = setup({ policy: STORED_ON });
			expect((await refusal(requireApplyAuthorization(f.db, oauth(), "deploy", DEPLOY_TARGET))).code).toBe("not_permitted");
			expect(fake.oauthClientRefusal).toHaveBeenCalledWith(ORG, expect.anything(), null);
		});

		it("lets a listed client on to the approval check", async () => {
			enterprise.current = fakeEnterprisePolicy(true).policy;
			const f = setup({
				policy: STORED_ON,
				approval: [approvalRow({ requester_credential: "agent_oauth", requester_credential_ref: "claude-code", approver_user_id: "someone-else" })],
			});
			await expect(requireApplyAuthorization(f.db, oauth("claude-code"), "deploy", DEPLOY_TARGET, APPROVAL)).resolves.toEqual({
				approvalId: APPROVAL,
			});
		});

		it("lets any client on when the organization is not entitled (unlicensed = core)", async () => {
			enterprise.current = fakeEnterprisePolicy(false).policy;
			const f = setup({ policy: STORED_ON });
			expect((await refusal(requireApplyAuthorization(f.db, oauth("cursor"), "deploy", DEPLOY_TARGET))).code).toBe(
				"approval_required",
			);
		});

		it("is not asked for any other credential kind", async () => {
			const fake = fakeEnterprisePolicy(true);
			enterprise.current = fake.policy;
			const f = setup({ policy: STORED_ON });
			await refusal(requireApplyAuthorization(f.db, { kind: "actor", actor: actorOf("agent_in_app") }, "deploy", DEPLOY_TARGET));
			expect(fake.oauthClientRefusal).not.toHaveBeenCalled();
		});
	});
});
