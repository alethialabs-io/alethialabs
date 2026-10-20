// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A RE-RUN OF A PROJECT'S JOB IS A FRESH RUN OF ITS OPERATION (#6121, lib/jobs/operation.ts), against
// real Postgres: it goes through the entry point a fresh deploy uses, so the environment's
// one-job-in-flight guard holds for it, and it deploys the project's CURRENT configuration — not the
// snapshot frozen into the job it was started from.
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

describeIfDb("a re-run of a project's deploy is a fresh deploy", () => {
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
		vi.mocked(authorize).mockResolvedValue({ userId: USER, orgId: ORG });
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

	it("deploys the project's current configuration to the same environment, not the original snapshot", async () => {
		const result = await rerunJob({ jobId: original });
		if (!result.ok) throw new Error(`re-run refused: ${JSON.stringify(result.error)}`);
		const created = (await jobsOn()).find((r) => r.id === result.data.id);
		expect(created).toMatchObject({ job_type: "DEPLOY", environment_id: envId });
		expect(JSON.stringify(created?.config_snapshot)).not.toContain(STALE);
		// The fresh-run entry point moved the environment on, which is the guard the next test meets.
		const [env] = await getServiceDb()
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId));
		expect(env?.status).not.toBe("ACTIVE");
	});

	it("is refused while another job is in flight on the environment, and queues nothing", async () => {
		const first = await rerunJob({ jobId: original });
		expect(first.ok).toBe(true);
		const before = (await jobsOn()).length;

		// No settle: the first re-run's deploy is still in flight on the environment.
		const second = await rerunJob({ jobId: original });
		expect(second).toMatchObject({ ok: false, error: { kind: "conflict" } });
		expect((await jobsOn()).length).toBe(before);
	});
});
