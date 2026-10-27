// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A JOB OF A PROJECT IS THAT PROJECT'S OPERATION (#6121, lib/jobs/operation.ts), against real
// Postgres and the edition's PDP: re-running a project's deploy, or cancelling it, takes `deploy` on
// the project — the org-level job permissions alone are not enough.
//
// One org, one project P with a finished deploy and a queued deploy, authored by an admin who never
// acts. Two operators act: OPERATOR holds the operator role (job create/edit, project deploy);
// NO_DEPLOY holds the same role and an explicit deny on deploying P. Both are written the way the
// app writes them — the Postgres row, then its tuple mirror — so the enterprise PDP reads them too.
//
// The other half of the rule — that a re-run goes through the fresh-run entry point, its environment
// guard and the project's current configuration — is tests/integration/jobs-rerun-entry.test.ts.
//
// WHAT IS MOCKED: the CLI guard's credential resolution (`authorizeCli`, to the same caller), and
// the scaler. The console actions run under `runWithActor`, as the read router binds an actor.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: "", org: "" }));
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorizeCli: async () => ({
		actor: { userId: h.user, orgId: h.org, credential: "session" },
		credential: "session",
		orgScope: [h.org, h.user],
	}),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST as cliCancel } from "@/app/api/cli/jobs/[id]/cancel/route";
import { cancelJob, rerunJob } from "@/app/server/actions/jobs";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	grants,
	jobs,
	member,
	organization,
	projects,
	resourceHierarchy,
	user,
} from "@/lib/db/schema";
import { editionState } from "@/lib/enterprise";
import { describeIfDb, purgeAuthzActivityLog, seedJob } from "./db";

const ORG = randomUUID();
const ADMIN = randomUUID(); // authors every row; never acts
const OPERATOR = randomUUID(); // may deploy P
const NO_DEPLOY = randomUUID(); // the same role, and an explicit deny on deploying P
const USERS = [ADMIN, OPERATOR, NO_DEPLOY];
const P = randomUUID();
/** A deploy of P in `status`, seeded for ONE case — no case depends on another's leftovers. */
function deployOfP(status: "SUCCESS" | "QUEUED"): Promise<string> {
	return seedJob(ADMIN, ORG, { project_id: P, job_type: "DEPLOY", status });
}

/** Cancels `jobId` from the CLI as `userId`; returns the HTTP status. */
async function cliCancelAs(userId: string, jobId: string): Promise<number> {
	h.user = userId;
	h.org = ORG;
	const res = await cliCancel(new Request(`https://console.test/api/cli/jobs/${jobId}/cancel`, { method: "POST" }), {
		params: Promise.resolve({ id: jobId }),
	});
	return res.status;
}

/** Runs an action as `userId` in the org. */
function actAs<T>(userId: string, run: () => Promise<T>): Promise<T> {
	return runWithActor({ userId, orgId: ORG, credential: "session" }, run);
}

/** The job's current status. */
async function statusOf(jobId: string): Promise<string | undefined> {
	const [row] = await getServiceDb().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
	return row?.status;
}

/** How many jobs P has. */
async function jobsOnP(): Promise<number> {
	return (await getServiceDb().select({ id: jobs.id }).from(jobs).where(eq(jobs.project_id, P))).length;
}

describeIfDb("acting on a project's job takes the project's permission for its operation", () => {
	beforeAll(async () => {
		const state = editionState();
		const expected = process.env.ALETHIA_EDITION === "enterprise" ? "enterprise" : "community";
		if (state.kind !== expected) {
			throw new Error(`the ${expected} edition did not load (${JSON.stringify(state)}); this suite would measure another engine`);
		}

		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values(USERS.map((id) => ({ id, email: `it-6121-op-${id}@example.test` })));
		await db.insert(organization).values({ id: ORG, name: `it-6121-op-${ORG.slice(0, 8)}`, slug: `it-6121-op-${ORG.slice(0, 8)}` });
		await db.insert(member).values([
			{ organizationId: ORG, userId: ADMIN, role: "admin" },
			{ organizationId: ORG, userId: OPERATOR, role: "operator" },
			{ organizationId: ORG, userId: NO_DEPLOY, role: "operator" },
		]);
		await ensureMemberGrant(ORG, ADMIN, "admin");
		await ensureMemberGrant(ORG, OPERATOR, "operator");
		await ensureMemberGrant(ORG, NO_DEPLOY, "operator");
		await db.insert(projects).values({
			id: P,
			user_id: ADMIN,
			org_id: ORG,
			project_name: `it-6121-op-${P.slice(0, 8)}`,
			region: "eu-west-1",
			iac_version: "1.0.0",
		});
		await db.insert(resourceHierarchy).values({ child_type: "project", child_id: P, parent_type: "org", parent_id: ORG });
		await getTupleSync().syncHierarchyEdge({ childType: "project", childId: P, parentType: "org", parentId: ORG });
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: NO_DEPLOY,
			effect: "deny",
			permission_key: "project:deploy",
			resource_type: "project",
			resource_id: P,
		});
		await getTupleSync().syncScopedGrant({
			orgId: ORG,
			principalType: "user",
			principalId: NO_DEPLOY,
			effect: "deny",
			resourceType: "project",
			resourceId: P,
			roleId: null,
			permissionKey: "project:deploy",
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		await db.delete(resourceHierarchy).where(eq(resourceHierarchy.parent_id, ORG));
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	it("a member with the org's job permissions but without deploy on P cannot re-run P's deploy", async () => {
		const finished = await deployOfP("SUCCESS");
		const before = await jobsOnP();
		expect(await actAs(NO_DEPLOY, () => rerunJob({ jobId: finished }))).toMatchObject({
			ok: false,
			error: { kind: "forbidden" },
		});
		expect(await jobsOnP()).toBe(before);
	});

	it("…nor cancel it, in the console", async () => {
		const queued = await deployOfP("QUEUED");
		expect(await actAs(NO_DEPLOY, () => cancelJob({ jobId: queued }))).toMatchObject({
			ok: false,
			error: { kind: "forbidden" },
		});
		expect(await statusOf(queued)).toBe("QUEUED");
	});

	it("…nor from the CLI", async () => {
		const queued = await deployOfP("QUEUED");
		expect(await cliCancelAs(NO_DEPLOY, queued)).toBe(403);
		expect(await statusOf(queued)).toBe("QUEUED");
	});

	it("a member who may deploy P cancels it in the console, with completed_at stamped", async () => {
		const queued = await deployOfP("QUEUED");
		expect(await actAs(OPERATOR, () => cancelJob({ jobId: queued }))).toEqual({ ok: true, data: null });
		const [row] = await getServiceDb()
			.select({ status: jobs.status, completed_at: jobs.completed_at })
			.from(jobs)
			.where(eq(jobs.id, queued));
		expect(row?.status).toBe("CANCELLED");
		expect(row?.completed_at).toBeInstanceOf(Date);
	});

	it("…and from the CLI, through the same cancel", async () => {
		const queued = await deployOfP("QUEUED");
		expect(await cliCancelAs(OPERATOR, queued)).toBe(200);
		const [row] = await getServiceDb()
			.select({ status: jobs.status, completed_at: jobs.completed_at })
			.from(jobs)
			.where(eq(jobs.id, queued));
		expect(row?.status).toBe("CANCELLED");
		expect(row?.completed_at).toBeInstanceOf(Date);
	});

	it("a finished job is not rewritten by a cancel, from either surface", async () => {
		const finished = await deployOfP("SUCCESS");
		expect(await actAs(OPERATOR, () => cancelJob({ jobId: finished }))).toMatchObject({
			ok: false,
			error: { kind: "conflict" },
		});
		expect(await cliCancelAs(OPERATOR, finished)).toBe(400);
		expect(await statusOf(finished)).toBe("SUCCESS");
	});
});
