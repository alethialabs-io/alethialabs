// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A RE-RUN OF A PROJECT'S DEPLOY QUEUES NOTHING (#6121, lib/jobs/operation.ts; decision M23, #6780),
// against real Postgres. A deploy applies a current reviewed plan, and the plan the original deploy
// applied stopped being current when that deploy was queued, so a re-run never re-applies the frozen
// snapshot and never queues a deploy of its own: it answers "plan again". The environment's
// one-job-in-flight guard still comes first: while a job runs on the environment the answer is that
// conflict, and nothing is queued either way.
//
// The actions run for real — config snapshot, environment transition and all. Only the PDP (the
// permission half is tests/integration/jobs-rerun-authority.test.ts), the visibility predicate (its
// own suite is tests/integration/jobs-visibility.test.ts), the two billing gates and the scaler are
// stubbed — the approval-idempotency suite's shape.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorize: vi.fn(),
}));
vi.mock("@/lib/jobs/visibility", async () => {
	const { sql: raw } = await import("drizzle-orm");
	return { jobVisibleTo: vi.fn(async () => raw`true`) };
});
vi.mock("@/lib/billing/usage-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/job-quota", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/job-quota")>()),
	assertJobQuotaAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { rerunJob } from "@/app/server/actions/jobs";
import { tryPlanProject } from "@/app/server/actions/projects";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { auditLog, cloudIdentities, jobs, projectEnvironments, projects } from "@/lib/db/schema";

const ORG = randomUUID();
const USER = randomUUID();
/** A marker only the ORIGINAL job's frozen snapshot carries. */
const STALE = `stale-config-${randomUUID()}`;

let identityId = "";
let projectId = "";
let envId = "";
let original = "";

/** Every job on the project, oldest first. */
async function jobsOn() {
	return getServiceDb()
		.select({
			id: jobs.id,
			job_type: jobs.job_type,
			environment_id: jobs.environment_id,
			config_snapshot: jobs.config_snapshot,
		})
		.from(jobs)
		.where(eq(jobs.project_id, projectId))
		.orderBy(jobs.created_at);
}

/** Settles every job of the project and puts its environment back to ACTIVE. */
async function settle() {
	const db = getServiceDb();
	await db.update(jobs).set({ status: "SUCCESS" }).where(eq(jobs.project_id, projectId));
	await db.update(projectEnvironments).set({ status: "ACTIVE" }).where(eq(projectEnvironments.id, envId));
}

describeIfDb("a re-run of a project's deploy says to plan again (decision M23)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		const [identity] = await db
			.insert(cloudIdentities)
			.values({ user_id: USER, org_id: ORG, provider: "aws", name: `it-6121-identity-${ORG.slice(0, 8)}` })
			.returning({ id: cloudIdentities.id });
		identityId = identity.id;
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: `it-6121-rerun-${ORG.slice(0, 8)}`,
				region: "us-east-1",
				iac_version: "1.9.5",
				cloud_identity_id: identityId,
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const [e] = await db
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, name: "staging", status: "ACTIVE", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;
		// The job a user clicks Re-run on: last month's deploy, its configuration frozen in it.
		const [j] = await db
			.insert(jobs)
			.values({
				user_id: USER,
				org_id: ORG,
				project_id: projectId,
				environment_id: envId,
				cloud_identity_id: identityId,
				job_type: "DEPLOY",
				status: "SUCCESS",
				config_snapshot: { marker: STALE },
			})
			.returning({ id: jobs.id });
		original = j.id;
	});

	beforeEach(async () => {
		vi.mocked(authorize).mockResolvedValue({ userId: USER, orgId: ORG, credential: "session" });
		await settle();
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(auditLog).where(eq(auditLog.project_id, projectId));
		await db.delete(jobs).where(eq(jobs.project_id, projectId));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
		await db.delete(cloudIdentities).where(inArray(cloudIdentities.id, [identityId]));
	});

	it("queues nothing and says to plan again, leaving the environment as it was", async () => {
		const before = (await jobsOn()).length;
		expect(await rerunJob({ jobId: original })).toEqual({
			ok: false,
			error: {
				kind: "conflict",
				message:
					"A deploy applies a reviewed plan, so it runs again from a new one: plan this environment, review the plan, then apply it.",
			},
		});
		expect((await jobsOn()).length).toBe(before);
		// The frozen snapshot of the original job is never queued again.
		expect((await jobsOn()).filter((r) => JSON.stringify(r.config_snapshot).includes(STALE))).toHaveLength(1);
		const [env] = await getServiceDb()
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId));
		expect(env?.status).toBe("ACTIVE");
	});

	it("is refused with the in-flight conflict while another job runs on the environment, and queues nothing", async () => {
		// A preview in flight on the environment: the environment is QUEUED until it settles.
		const plan = await tryPlanProject(projectId, undefined, envId);
		expect(plan.ok).toBe(true);
		const before = (await jobsOn()).length;

		// No settle: the in-flight answer wins over "plan again".
		const second = await rerunJob({ jobId: original });
		expect(second).toEqual({
			ok: false,
			error: {
				kind: "conflict",
				message: "Environment is not in a valid state for this operation — a job may already be in progress.",
			},
		});
		expect((await jobsOn()).length).toBe(before);
	});
});
