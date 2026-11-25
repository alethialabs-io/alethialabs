// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: plan-bound apply on the console side (AGT-S0b, #6780), against real Postgres.
//
// A deploy someone asks for applies a current reviewed plan of its environment (decision M23), and
// the DEPLOY row carries what the runner needs to hold the apply to it: the plan job, the plan's
// digest and the configuration hash. The runner that claims the DEPLOY may read that plan, and no
// other runner may.
//
// WHY THIS IS AN INTEGRATION TEST. The rule reads two things the database decides: that the plan's
// configuration hash equals the hash of the snapshot the deploy would freeze NOW (so a re-built
// snapshot must hash the same when nothing changed), and which jobs were queued after the plan. Only
// the real actions over real rows show both. The PDP, the two billing gates and the scaler are
// stubbed (proven elsewhere, and not the subject).

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeIfDb, seedManagedRunner } from "./db";

vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorize: vi.fn(),
}));
vi.mock("@/lib/billing/usage-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/job-quota", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/job-quota")>()),
	assertJobQuotaAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { tryPlanProject, tryProvisionProject } from "@/app/server/actions/projects";
import { configurationHashOf } from "@/lib/approvals/plan-binding";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { auditLog, cloudIdentities, jobs, projectEnvironments, projects, runners } from "@/lib/db/schema";
import { verifyRunnerMayReadJob } from "@/lib/runners/auth";

const ORG = randomUUID();
const USER = randomUUID();
/** The digest a succeeded plan's receipt records (any SHA-256 hex). */
const DIGEST = "5e".repeat(32);

let identityId: string;
let projectId: string;
let envId: string;
/** A second environment of the same project, whose plans must not apply to `envId`. */
let otherEnvId: string;
const runnerIds: string[] = [];

/** Narrows a `try*` result to its job id, failing the test with the refusal otherwise. */
function jobIdOf(res: { ok: true; jobId: string } | { ok: false; error: string }): string {
	if (!res.ok) throw new Error(`expected a queued job, got a refusal: ${res.error}`);
	return res.jobId;
}

/** Settles every job of the project and puts both environments back to ACTIVE. */
async function settleAll() {
	const db = getServiceDb();
	await db.update(jobs).set({ status: "SUCCESS" }).where(eq(jobs.project_id, projectId));
	await db
		.update(projectEnvironments)
		.set({ status: "ACTIVE" })
		.where(inArray(projectEnvironments.id, [envId, otherEnvId]));
}

/** Plans `env`, then lets the plan succeed with `digest` recorded (as the status route stamps it). */
async function succeededPlan(env: string, digest: string | null = DIGEST): Promise<string> {
	const planId = jobIdOf(await tryPlanProject(projectId, undefined, env));
	await settleAll();
	await getServiceDb().update(jobs).set({ plan_sha256: digest }).where(eq(jobs.id, planId));
	return planId;
}

/** One job row's plan-binding columns. */
async function row(id: string) {
	const [r] = await getServiceDb()
		.select({
			job_type: jobs.job_type,
			plan_job_id: jobs.plan_job_id,
			plan_sha256: jobs.plan_sha256,
			configuration_hash: jobs.configuration_hash,
			config_snapshot: jobs.config_snapshot,
			initiated_by: jobs.initiated_by,
		})
		.from(jobs)
		.where(eq(jobs.id, id));
	return r;
}

/** How many DEPLOY rows the project has. */
async function deployCount(): Promise<number> {
	const rows = await getServiceDb()
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.project_id, projectId), eq(jobs.job_type, "DEPLOY")));
	return rows.length;
}

describeIfDb("plan-bound apply — the console half (AGT-S0b)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		const [identity] = await db
			.insert(cloudIdentities)
			.values({ user_id: USER, org_id: ORG, provider: "aws", name: `it-s0b-identity-${ORG.slice(0, 8)}` })
			.returning({ id: cloudIdentities.id });
		identityId = identity.id;
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: `it-s0b-${ORG.slice(0, 8)}`,
				region: "us-east-1",
				iac_version: "1.9.5",
				cloud_identity_id: identityId,
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const envs = await db
			.insert(projectEnvironments)
			.values([
				{ project_id: projectId, user_id: USER, name: "prod", status: "DRAFT", is_default: true },
				{ project_id: projectId, user_id: USER, name: "staging", status: "DRAFT", is_default: false },
			])
			.returning({ id: projectEnvironments.id, name: projectEnvironments.name });
		envId = envs.find((e) => e.name === "prod")?.id ?? "";
		otherEnvId = envs.find((e) => e.name === "staging")?.id ?? "";
	});

	beforeEach(async () => {
		vi.mocked(authorize).mockResolvedValue({ credential: "session", userId: USER, orgId: ORG });
		await settleAll();
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(auditLog).where(eq(auditLog.project_id, projectId));
		await db.delete(jobs).where(eq(jobs.project_id, projectId));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
		await db.delete(cloudIdentities).where(eq(cloudIdentities.id, identityId));
		if (runnerIds.length > 0) await db.delete(runners).where(inArray(runners.id, runnerIds));
	});

	describe("what the rows carry", () => {
		it("a PLAN carries the hash of the snapshot it froze, over the jsonb read-back", async () => {
			const planId = jobIdOf(await tryPlanProject(projectId, undefined, envId));
			const plan = await row(planId);
			expect(plan.configuration_hash).toBe(configurationHashOf(plan.config_snapshot));
		});

		it("a DEPLOY of a current plan carries the plan, its digest, and the same configuration hash", async () => {
			const planId = await succeededPlan(envId);
			const deployId = jobIdOf(await tryProvisionProject(projectId, planId, undefined, envId));

			const [plan, deploy] = [await row(planId), await row(deployId)];
			expect(deploy).toMatchObject({
				job_type: "DEPLOY",
				plan_job_id: planId,
				plan_sha256: DIGEST,
				initiated_by: "user",
			});
			// Re-built at apply time from unchanged rows, the snapshot hashes to what the plan recorded.
			expect(deploy.configuration_hash).toBe(plan.configuration_hash);
		});

		it("takes the digest from the plan's verify receipt when the column was never stamped", async () => {
			const planId = await succeededPlan(envId, null);
			await getServiceDb()
				.update(jobs)
				.set({
					execution_metadata: {
						verify_receipt: {
							algorithm: "none",
							receipt: {
								version: "1",
								plan_sha256: DIGEST,
								catalog_version: "1",
								provider: "aws",
								verdict: "pass",
								report: {
									verdict: "pass",
									catalog_version: "1",
									provider: "aws",
									controls: [],
									summary: { pass: 0, fail: 0, warn: 0, not_evaluable: 0 },
								},
							},
						},
					},
				})
				.where(eq(jobs.id, planId));

			const deployId = jobIdOf(await tryProvisionProject(projectId, planId, undefined, envId));
			expect((await row(deployId)).plan_sha256).toBe(DIGEST);
		});

		it("the database refuses a digest that is not lowercase SHA-256 hex", async () => {
			await expect(
				getServiceDb()
					.insert(jobs)
					.values({
						user_id: USER,
						org_id: ORG,
						project_id: projectId,
						environment_id: envId,
						job_type: "DEPLOY",
						status: "SUCCESS",
						config_snapshot: {},
						plan_sha256: "ABC",
					}),
			).rejects.toMatchObject({ cause: { code: "23514" } });
		});
	});

	describe("which deploys are refused (decision M23), each queuing nothing", () => {
		it("a deploy that names no plan", async () => {
			const before = await deployCount();
			expect(await tryProvisionProject(projectId, undefined, undefined, envId)).toEqual({
				ok: false,
				error: "A deploy applies a reviewed plan. Plan this environment, review the plan, then apply it.",
			});
			expect(await deployCount()).toBe(before);
		});

		it("a plan of another environment of the same project", async () => {
			const otherPlan = await succeededPlan(otherEnvId);
			const before = await deployCount();
			const res = await tryProvisionProject(projectId, otherPlan, undefined, envId);
			expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/is not a plan of this environment/) });
			expect(await deployCount()).toBe(before);
		});

		it("a plan whose configuration moved since it was made", async () => {
			const planId = await succeededPlan(envId);
			await getServiceDb()
				.update(jobs)
				.set({ configuration_hash: "0f".repeat(32) })
				.where(eq(jobs.id, planId));
			const before = await deployCount();
			const res = await tryProvisionProject(projectId, planId, undefined, envId);
			expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/configuration changed.*Plan again/) });
			expect(await deployCount()).toBe(before);
		});

		it("a plan that a deploy already followed", async () => {
			const planId = await succeededPlan(envId);
			jobIdOf(await tryProvisionProject(projectId, planId, undefined, envId));
			await settleAll();
			const before = await deployCount();
			const res = await tryProvisionProject(projectId, planId, undefined, envId);
			expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/queued after plan.*Plan again/) });
			expect(await deployCount()).toBe(before);
		});

		it("a plan that has not succeeded", async () => {
			const planId = jobIdOf(await tryPlanProject(projectId, undefined, envId));
			await getServiceDb()
				.update(projectEnvironments)
				.set({ status: "ACTIVE" })
				.where(eq(projectEnvironments.id, envId));
			const res = await tryProvisionProject(projectId, planId, undefined, envId);
			expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/has not succeeded \(status QUEUED\)/) });
		});

		it("a current plan with no recorded digest", async () => {
			const planId = await succeededPlan(envId, null);
			const res = await tryProvisionProject(projectId, planId, undefined, envId);
			expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/no recorded plan digest/) });
		});
	});

	describe("which runner may read the plan a DEPLOY applies", () => {
		it("only the runner holding the in-flight DEPLOY that names it, only that plan, only while in flight", async () => {
			const planner = await seedManagedRunner(`it-s0b-planner-${ORG.slice(0, 8)}`);
			const applier = await seedManagedRunner(`it-s0b-applier-${ORG.slice(0, 8)}`);
			const bystander = await seedManagedRunner(`it-s0b-bystander-${ORG.slice(0, 8)}`);
			runnerIds.push(planner, applier, bystander);

			const planId = await succeededPlan(envId);
			const unrelatedPlan = await succeededPlan(otherEnvId);
			await getServiceDb()
				.update(jobs)
				.set({ runner_id: planner })
				.where(inArray(jobs.id, [planId, unrelatedPlan]));
			const deployId = jobIdOf(await tryProvisionProject(projectId, planId, undefined, envId));
			await getServiceDb()
				.update(jobs)
				.set({ runner_id: applier, status: "CLAIMED" })
				.where(eq(jobs.id, deployId));

			expect(await verifyRunnerMayReadJob(planner, planId)).toEqual({ error: null, access: "owner" });
			expect(await verifyRunnerMayReadJob(applier, planId)).toEqual({ error: null, access: "applies_plan" });
			expect((await verifyRunnerMayReadJob(bystander, planId)).error?.status).toBe(403);
			// The applying runner reads the plan its DEPLOY names, not another plan of the same runner.
			expect((await verifyRunnerMayReadJob(applier, unrelatedPlan)).error?.status).toBe(403);

			// Once the apply leaves the runner's hands, so does the read.
			await getServiceDb().update(jobs).set({ status: "SUCCESS" }).where(eq(jobs.id, deployId));
			expect((await verifyRunnerMayReadJob(applier, planId)).error?.status).toBe(403);
		});
	});
});
