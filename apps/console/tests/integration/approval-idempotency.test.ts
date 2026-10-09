// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: one approval queues one job (#5797), against real Postgres.
//
// The agent's approval card calls `tryPlanProject` / `tryProvisionProject` on Approve. If the
// approval's output is then lost (its continuation refused, or the page reloaded first), the card
// comes back actionable, and a second Approve used to queue a SECOND plan or deploy — real cloud
// spend, and a second apply against the same environment. The card now passes an idempotency key
// (`threadId:toolCallId` of the proposing tool call); the server stores its digest on the job under
// a partial unique index and inserts `ON CONFLICT DO NOTHING` + read-back in one transaction.
//
// WHY THIS IS AN INTEGRATION TEST. The guarantee is a unique index and a conflict arbiter racing
// two transactions. A mocked db proves what the action passed to the builder; only Postgres
// proves that the second of two concurrent inserts WAITS for the first, conflicts, and reads the
// committed row back. So the actions run for real — config snapshot, env CAS and all — and only
// the PDP, the two billing gates and the scaler are stubbed (proven elsewhere, and not the subject).
//
// Each scenario first "finishes" the previous job (job SUCCESS, env back to ACTIVE), because that is
// the shape of the defect: while a job is in flight the env CAS already refuses a second enqueue,
// and the double queue happens once the first job has settled and the stale card is clicked again.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

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

import {
	getApprovedJob,
	tryPlanProject,
	tryProvisionProject,
} from "@/app/server/actions/projects";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";

const ORG = randomUUID();
/** Another org the same person acts in. */
const OTHER_ORG = randomUUID();
/** The person who approves. */
const USER = randomUUID();
/** A second member of the same org, approving with the SAME key on the SAME project. */
const OTHER_USER = randomUUID();

/** A PERSONAL cloud identity of USER (visible to USER in any org) — on `projectId`. */
let identityId: string;
/** An ORG-scoped identity (visible to every member of ORG) — on `otherProjectId`. */
let orgIdentityId: string;
let projectId: string;
let envId: string;
/** A second project in the same org, for the key-is-scoped-to-the-project case. */
let otherProjectId: string;
let otherEnvId: string;

/** Acts as `userId` in ORG for every authorize() call that follows. */
function actAs(userId: string) {
	vi.mocked(authorize).mockResolvedValue({ userId, orgId: ORG });
}

/** Seeds a project in ORG on `identity`, with a default DRAFT environment; returns both ids. */
async function seedProject(
	name: string,
	identity: string,
): Promise<{ projectId: string; envId: string }> {
	const db = getServiceDb();
	const [p] = await db
		.insert(projects)
		.values({
			user_id: USER,
			org_id: ORG,
			project_name: name,
			region: "us-east-1",
			iac_version: "1.9.5",
			cloud_identity_id: identity,
		})
		.returning({ id: projects.id });
	const [e] = await db
		.insert(projectEnvironments)
		.values({
			project_id: p.id,
			user_id: USER,
			name: "prod",
			status: "DRAFT",
			is_default: true,
		})
		.returning({ id: projectEnvironments.id });
	return { projectId: p.id, envId: e.id };
}

/**
 * Settles every job of the seeded projects and puts their environments back to ACTIVE — the state
 * a stale card is clicked in, after the first job has run.
 */
async function settleAll() {
	const db = getServiceDb();
	await db
		.update(jobs)
		.set({ status: "SUCCESS" })
		.where(inArray(jobs.project_id, [projectId, otherProjectId]));
	await db
		.update(projectEnvironments)
		.set({ status: "ACTIVE" })
		.where(inArray(projectEnvironments.id, [envId, otherEnvId]));
}

/** Every job row on `project`, oldest first. */
async function jobsOn(project: string) {
	return getServiceDb()
		.select({
			id: jobs.id,
			user_id: jobs.user_id,
			job_type: jobs.job_type,
			idempotency_key: jobs.idempotency_key,
		})
		.from(jobs)
		.where(eq(jobs.project_id, project))
		.orderBy(jobs.created_at);
}

/** Narrows a `try*` result to its job id, failing the test with the refusal otherwise. */
function jobIdOf(res: { ok: true; jobId: string } | { ok: false; error: string }): string {
	if (!res.ok) throw new Error(`expected a queued job, got a refusal: ${res.error}`);
	return res.jobId;
}

describeIfDb("approval idempotency — one approval, one job (#5797)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		const [identity] = await db
			.insert(cloudIdentities)
			.values({
				user_id: USER,
				org_id: ORG,
				provider: "aws",
				name: `it-5797-identity-${ORG.slice(0, 8)}`,
			})
			.returning({ id: cloudIdentities.id });
		identityId = identity.id;
		const [orgIdentity] = await db
			.insert(cloudIdentities)
			.values({
				user_id: USER,
				org_id: ORG,
				scope: "org",
				provider: "aws",
				name: `it-5797-org-identity-${ORG.slice(0, 8)}`,
			})
			.returning({ id: cloudIdentities.id });
		orgIdentityId = orgIdentity.id;
		({ projectId, envId } = await seedProject(`it-5797-${ORG.slice(0, 8)}`, identityId));
		({ projectId: otherProjectId, envId: otherEnvId } = await seedProject(
			`it-5797-b-${ORG.slice(0, 8)}`,
			orgIdentityId,
		));
	});

	beforeEach(async () => {
		actAs(USER);
		await settleAll();
	});

	afterAll(async () => {
		const db = getServiceDb();
		const ids = [projectId, otherProjectId];
		await db.delete(auditLog).where(inArray(auditLog.project_id, ids));
		await db.delete(jobs).where(inArray(jobs.project_id, ids));
		await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, ids));
		await db.delete(projects).where(inArray(projects.id, ids));
		await db
			.delete(cloudIdentities)
			.where(inArray(cloudIdentities.id, [identityId, orgIdentityId]));
	});

	it("a second approval of one plan proposal returns the first job and queues nothing", async () => {
		const key = `thread-1:toolu_${randomUUID()}`;
		const before = (await jobsOn(projectId)).length;

		const first = jobIdOf(await tryPlanProject(projectId, undefined, envId, key));
		await settleAll();
		const second = jobIdOf(await tryPlanProject(projectId, undefined, envId, key));

		expect(second).toBe(first);
		expect((await jobsOn(projectId)).length).toBe(before + 1);
		// The card's re-render lookup finds the same job.
		await expect(getApprovedJob(projectId, "plan_project", key)).resolves.toEqual({
			jobId: first,
		});
	});

	it("two CONCURRENT approvals of one proposal queue exactly one job and both answer it", async () => {
		const key = `thread-1:toolu_${randomUUID()}`;
		const before = (await jobsOn(projectId)).length;

		const [a, b] = await Promise.all([
			tryPlanProject(projectId, undefined, envId, key),
			tryPlanProject(projectId, undefined, envId, key),
		]);

		expect(jobIdOf(a)).toBe(jobIdOf(b));
		expect((await jobsOn(projectId)).length).toBe(before + 1);
	});

	it("two concurrent approvals of one DEPLOY proposal queue exactly one deploy", async () => {
		const key = `thread-1:toolu_${randomUUID()}`;
		const before = (await jobsOn(projectId)).length;

		const [a, b] = await Promise.all([
			tryProvisionProject(projectId, undefined, undefined, envId, key),
			tryProvisionProject(projectId, undefined, undefined, envId, key),
		]);

		expect(jobIdOf(a)).toBe(jobIdOf(b));
		const rows = await jobsOn(projectId);
		expect(rows.length).toBe(before + 1);
		expect(rows.at(-1)?.job_type).toBe("DEPLOY");
	});

	it("different proposals queue different jobs", async () => {
		const first = jobIdOf(
			await tryPlanProject(projectId, undefined, envId, `thread-1:toolu_${randomUUID()}`),
		);
		await settleAll();
		const second = jobIdOf(
			await tryPlanProject(projectId, undefined, envId, `thread-1:toolu_${randomUUID()}`),
		);

		expect(second).not.toBe(first);
	});

	it("a plan key and a deploy key with the same text never resolve to each other's job", async () => {
		const key = `thread-1:toolu_${randomUUID()}`;
		const plan = jobIdOf(await tryPlanProject(projectId, undefined, envId, key));
		await settleAll();
		const deploy = jobIdOf(
			await tryProvisionProject(projectId, undefined, undefined, envId, key),
		);

		expect(deploy).not.toBe(plan);
	});

	it("a key never resolves to ANOTHER member's job, even in the same org and project", async () => {
		const key = `thread-1:toolu_${randomUUID()}`;
		const mine = jobIdOf(await tryPlanProject(otherProjectId, undefined, otherEnvId, key));
		await settleAll();

		actAs(OTHER_USER);
		await expect(getApprovedJob(otherProjectId, "plan_project", key)).resolves.toBeNull();
		const theirs = jobIdOf(await tryPlanProject(otherProjectId, undefined, otherEnvId, key));

		expect(theirs).not.toBe(mine);
		const row = (await jobsOn(otherProjectId)).find((r) => r.id === theirs);
		expect(row?.user_id).toBe(OTHER_USER);
	});

	it("a key is scoped to the actor's ORG: the same person's job under another org is never returned", async () => {
		// RLS does not hide this row: `owner_all` is `user_id = current_owner OR org_id = current_org`,
		// and the row is the caller's own. Only the lookup's org predicate keeps it out.
		const key = `thread-1:toolu_${randomUUID()}`;
		vi.mocked(authorize).mockResolvedValue({ userId: USER, orgId: OTHER_ORG });
		const elsewhere = jobIdOf(await tryPlanProject(projectId, undefined, envId, key));
		await settleAll();

		actAs(USER);
		await expect(getApprovedJob(projectId, "plan_project", key)).resolves.toBeNull();
		const here = jobIdOf(await tryPlanProject(projectId, undefined, envId, key));
		expect(here).not.toBe(elsewhere);
	});

	it("a key is scoped to its project: the same key on another project queues that project's job", async () => {
		const key = `thread-1:toolu_${randomUUID()}`;
		const here = jobIdOf(await tryPlanProject(projectId, undefined, envId, key));
		await settleAll();
		const there = jobIdOf(await tryPlanProject(otherProjectId, undefined, otherEnvId, key));

		expect(there).not.toBe(here);
		await expect(getApprovedJob(otherProjectId, "plan_project", key)).resolves.toEqual({
			jobId: there,
		});
	});

	it("callers without a key keep their behaviour: every call queues, and no key is stored", async () => {
		const before = (await jobsOn(projectId)).length;
		const first = jobIdOf(await tryPlanProject(projectId, undefined, envId));
		await settleAll();
		const second = jobIdOf(await tryPlanProject(projectId, undefined, envId));

		expect(second).not.toBe(first);
		const rows = await getServiceDb()
			.select({ key: jobs.idempotency_key })
			.from(jobs)
			.where(and(eq(jobs.project_id, projectId), inArray(jobs.id, [first, second])));
		expect(rows).toEqual([{ key: null }, { key: null }]);
		expect((await jobsOn(projectId)).length).toBe(before + 2);
	});

	it("the stored key is a digest, not the thread and tool-call ids", async () => {
		const key = `thread-secret:toolu_${randomUUID()}`;
		const id = jobIdOf(await tryPlanProject(projectId, undefined, envId, key));
		const row = (await jobsOn(projectId)).find((r) => r.id === id);

		expect(row?.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.idempotency_key).not.toContain("thread-secret");
	});
});
