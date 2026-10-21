// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// JOB VISIBILITY FOLLOWS PROJECT VISIBILITY (#6121), against real Postgres, RLS and the edition's PDP.
//
// One org, two projects (P and Q), a job on each and one project-less job, all authored by an admin
// who never reads. Two org viewers read: VIEWER may view every project; DENIED holds an explicit
// deny on viewing P. The claim, for each read the jobs pages use — the list and its facet counts,
// the detail, the status, the plan result, the log head, one project's jobs — and for the log
// stream: a reader sees a job exactly when they may view its project, and a project-less job is
// org-wide.
//
// It runs in whichever edition the job sets (CI: enterprise, the OpenFGA PDP), so every grant and
// hierarchy edge is written the way the app writes it: the Postgres row, then its tuple mirror.
//
// The CLI's job surface follows the same rule — `GET /api/jobs`, `GET /api/cli/jobs/[id]`,
// `GET /api/cli/jobs/[id]/logs`, `POST /api/cli/jobs/[id]/cancel` — so the terminal and the browser
// agree about which jobs a reader has.
//
// WHAT IS MOCKED: the session lookup the log stream does (`getOwner`, `getActiveScope`), and the CLI
// guard's credential resolution (`authorizeCli`, to the same caller) — the session is the input
// here, not the unit. The readers run under `runWithActor`, the binding the
// read router itself applies (lib/rpc/base.ts).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: "", org: "" }));
vi.mock("@/lib/auth/owner", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth/owner")>()),
	getOwner: async () => h.user,
}));
vi.mock("@/lib/auth/scope", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth/scope")>()),
	getActiveScope: async (userId: string) => ({ userId, orgId: h.org }),
}));
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorizeCli: async () => ({
		actor: { userId: h.user, orgId: h.org },
		credential: "session",
		orgScope: [h.org, h.user],
	}),
}));

import { GET as cliJob } from "@/app/api/cli/jobs/[id]/route";
import { POST as cliCancel } from "@/app/api/cli/jobs/[id]/cancel/route";
import { GET as cliJobLogs } from "@/app/api/cli/jobs/[id]/logs/route";
import { GET as cliJobs } from "@/app/api/jobs/route";
import { GET as streamJobLogs } from "@/app/api/stream/jobs/[id]/route";
import { ForbiddenError } from "@/lib/authz/types";
import { editionState } from "@/lib/enterprise";
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
import {
	readJob,
	readJobLogsHead,
	readJobStatus,
	readJobsPage,
	readPlanResult,
	readProjectJobs,
} from "@/lib/rpc/procedures/jobs";
import { readRecentJobs } from "@/lib/rpc/procedures/workspace";
import { describeIfDb, purgeAuthzActivityLog, seedJob } from "./db";

const ORG = randomUUID();
const ADMIN = randomUUID(); // authors every row; never reads
const VIEWER = randomUUID(); // may view every project
const DENIED = randomUUID(); // explicitly denied viewing project P
const USERS = [ADMIN, VIEWER, DENIED];
const P = randomUUID();
const Q = randomUUID();
const seeded = { jobP: "", jobQ: "", jobOrg: "", scanP: "", legacyScanP: "", legacyScanQ: "" };

/** Runs a read as `userId` in the org, as the read router binds it. */
function readAs<T>(userId: string, read: () => Promise<T>): Promise<T> {
	return runWithActor({ userId, orgId: ORG }, read);
}

/** Opens the job's log stream as `userId` (already aborted, so it ends after the backlog) → status. */
async function streamStatus(userId: string, jobId: string): Promise<number> {
	h.user = userId;
	h.org = ORG;
	const res = await streamJobLogs(
		new Request(`https://console.test/api/stream/jobs/${jobId}`, { signal: AbortSignal.abort() }),
		{ params: Promise.resolve({ id: jobId }) },
	);
	await res.body?.cancel();
	return res.status;
}

/** Acts as `userId` in the org for the CLI routes; returns a request for `path`. */
function cliRequest(userId: string, path: string, method = "GET"): Request {
	h.user = userId;
	h.org = ORG;
	return new Request(`https://console.test${path}`, { method });
}

/** The job ids `GET /api/jobs` lists for `userId`. */
async function cliListed(userId: string): Promise<string[]> {
	const res = await cliJobs(cliRequest(userId, "/api/jobs?limit=100"));
	expect(res.status).toBe(200);
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null || !("jobs" in body) || !Array.isArray(body.jobs)) {
		throw new Error(`unexpected /api/jobs body: ${JSON.stringify(body)}`);
	}
	return body.jobs.flatMap((j: unknown) => (typeof j === "object" && j !== null && "id" in j && typeof j.id === "string" ? [j.id] : []));
}

/** The status of a by-id CLI route for `userId`. */
async function cliStatus(
	route: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
	userId: string,
	jobId: string,
	suffix = "",
	method = "GET",
): Promise<number> {
	const res = await route(cliRequest(userId, `/api/cli/jobs/${jobId}${suffix}`, method), {
		params: Promise.resolve({ id: jobId }),
	});
	return res.status;
}

/** The ids of a list of rows. */
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describeIfDb("job visibility follows project visibility", () => {
	beforeAll(async () => {
		// The edition is a premise: CI runs this file in both passes, and a broken enterprise load
		// must fail here rather than answer on the community engine.
		const state = editionState();
		const expected = process.env.ALETHIA_EDITION === "enterprise" ? "enterprise" : "community";
		if (state.kind !== expected) {
			throw new Error(`the ${expected} edition did not load (${JSON.stringify(state)}); this suite would measure another engine`);
		}

		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values(USERS.map((id) => ({ id, email: `it-6121-${id}@example.test` })));
		await db.insert(organization).values({ id: ORG, name: `it-6121-${ORG.slice(0, 8)}`, slug: `it-6121-${ORG.slice(0, 8)}` });
		await db.insert(member).values([
			{ organizationId: ORG, userId: ADMIN, role: "admin" },
			{ organizationId: ORG, userId: VIEWER, role: "viewer" },
			{ organizationId: ORG, userId: DENIED, role: "viewer" },
		]);
		await ensureMemberGrant(ORG, ADMIN, "admin");
		await ensureMemberGrant(ORG, VIEWER, "viewer");
		await ensureMemberGrant(ORG, DENIED, "viewer");
		await db.insert(projects).values(
			[P, Q].map((id) => ({
				id,
				user_id: ADMIN,
				org_id: ORG,
				project_name: `it-6121-${id.slice(0, 8)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			})),
		);
		// What creating a project writes beside it: the org → project edge (lib/queries/projects.ts),
		// mirrored to the enterprise PDP's store. A scoped grant on P is resolved through it.
		await db.insert(resourceHierarchy).values(
			[P, Q].map((id) => ({ child_type: "project", child_id: id, parent_type: "org", parent_id: ORG })),
		);
		for (const id of [P, Q]) {
			await getTupleSync().syncHierarchyEdge({ childType: "project", childId: id, parentType: "org", parentId: ORG });
		}
		// The explicit deny: DENIED may not view project P, and may view everything else. Written as
		// the grants action writes one — the row, then its mirror (app/server/actions/grants.ts).
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: DENIED,
			effect: "deny",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: P,
		});
		await getTupleSync().syncScopedGrant({
			orgId: ORG,
			principalType: "user",
			principalId: DENIED,
			effect: "deny",
			resourceType: "project",
			resourceId: P,
			roleId: null,
			permissionKey: "project:view",
		});
		seeded.jobP = await seedJob(ADMIN, ORG, { project_id: P, status: "SUCCESS" });
		seeded.jobQ = await seedJob(ADMIN, ORG, { project_id: Q, status: "SUCCESS" });
		seeded.jobOrg = await seedJob(ADMIN, ORG, { status: "SUCCESS" });
		// A scan of P, stored as the scan actions store one: its project in the snapshot AND the column.
		seeded.scanP = await seedJob(ADMIN, ORG, {
			job_type: "IAC_SCAN",
			project_id: P,
			status: "SUCCESS",
			config_snapshot: { project_id: P, iac_source_id: "src-1" },
		});
		// Scans as they were stored BEFORE scans carried the column: the project only in the snapshot.
		// (Seeded after migrate, so programmables.sql's backfill has not touched them: this is the
		// read-side fallback, for a deployment that has not run the backfill yet.)
		seeded.legacyScanP = await seedJob(ADMIN, ORG, {
			job_type: "CHART_SCAN",
			project_id: null,
			status: "SUCCESS",
			config_snapshot: { project_id: P, addon_id: "a-1" },
		});
		seeded.legacyScanQ = await seedJob(ADMIN, ORG, {
			job_type: "IAC_SCAN",
			project_id: null,
			status: "SUCCESS",
			config_snapshot: { project_id: Q, iac_source_id: "src-2" },
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

	describe("a reader with an explicit deny on project P", () => {
		it("sees no job of P in the list, nor P among its project facets — and still sees the rest", async () => {
			const page = await readAs(DENIED, () => readJobsPage({}));
			const listed = ids(page.rows);
			expect(listed).not.toContain(seeded.jobP);
			expect(listed).toEqual(expect.arrayContaining([seeded.jobQ, seeded.jobOrg]));
			expect(page.facets.projects.map((o) => o.value)).not.toContain(P);
			expect(listed).not.toContain(seeded.scanP);
			// A scan stored with its project only in the snapshot follows THAT project too.
			expect(listed).not.toContain(seeded.legacyScanP);
			expect(listed).toContain(seeded.legacyScanQ);
			expect(page.total).toBe(3);
		});

		it("the shell's job feed (workspace.recentJobs) shows no job of P either", async () => {
			const feed = ids(await readAs(DENIED, () => readRecentJobs()));
			expect(feed).not.toContain(seeded.jobP);
			expect(feed).not.toContain(seeded.legacyScanP);
			expect(feed).toEqual(expect.arrayContaining([seeded.jobQ, seeded.jobOrg]));
		});

		it("gets no detail for a job of P (as if it did not exist) — nor for a scan of P", async () => {
			expect(await readAs(DENIED, () => readJob(seeded.jobP))).toBeNull();
			expect(await readAs(DENIED, () => readJob(seeded.scanP))).toBeNull();
			expect(await readAs(DENIED, () => readJob(seeded.legacyScanP))).toBeNull();
			expect(await streamStatus(DENIED, seeded.legacyScanP)).toBe(404);
			expect(await readAs(DENIED, () => readJob(seeded.jobQ))).toMatchObject({ id: seeded.jobQ });
		});

		it.each<[string, (id: string) => Promise<unknown>]>([
			["status", (id: string) => readJobStatus(id)],
			["plan result", (id: string) => readPlanResult(id)],
			["log head", (id: string) => readJobLogsHead(id)],
		])("is refused the %s of a job of P as not-found", async (_label, read) => {
			await expect(readAs(DENIED, () => read(seeded.jobP))).rejects.toMatchObject({ kind: "not-found" });
			await expect(readAs(DENIED, () => read(seeded.jobOrg))).resolves.toBeTruthy();
		});

		it("is refused P's jobs by project", async () => {
			await expect(readAs(DENIED, () => readProjectJobs(P))).rejects.toBeInstanceOf(ForbiddenError);
		});

		it("is refused the log stream of a job of P, and served a project-less job's", async () => {
			expect(await streamStatus(DENIED, seeded.jobP)).toBe(404);
			expect(await streamStatus(DENIED, seeded.jobOrg)).toBe(200);
		});
	});

	describe("the CLI agrees with the console", () => {
		it("GET /api/jobs lists no job of P for the denied reader, and lists it for the viewer", async () => {
			const denied = await cliListed(DENIED);
			expect(denied).not.toContain(seeded.jobP);
			expect(denied).toEqual(expect.arrayContaining([seeded.jobQ, seeded.jobOrg]));
			expect(await cliListed(VIEWER)).toEqual(expect.arrayContaining([seeded.jobP, seeded.jobQ, seeded.jobOrg]));
		});

		it("GET /api/cli/jobs/[id] answers a job of P as not found for the denied reader only", async () => {
			expect(await cliStatus(cliJob, DENIED, seeded.jobP)).toBe(404);
			expect(await cliStatus(cliJob, DENIED, seeded.jobQ)).toBe(200);
			expect(await cliStatus(cliJob, VIEWER, seeded.jobP)).toBe(200);
		});

		it("GET /api/cli/jobs/[id]/logs answers a job of P as not found for the denied reader only", async () => {
			expect(await cliStatus(cliJobLogs, DENIED, seeded.jobP, "/logs")).toBe(404);
			expect(await cliStatus(cliJobLogs, DENIED, seeded.jobQ, "/logs")).toBe(200);
			expect(await cliStatus(cliJobLogs, VIEWER, seeded.jobP, "/logs")).toBe(200);
		});

		it("POST /api/cli/jobs/[id]/cancel answers a job of P as not found for the denied reader", async () => {
			expect(await cliStatus(cliCancel, DENIED, seeded.jobP, "/cancel", "POST")).toBe(404);
			// A job the reader can see is not a 404: it is refused for what it is (finished, or the
			// project permission), which is the cancel route's own subject.
			expect(await cliStatus(cliCancel, DENIED, seeded.jobQ, "/cancel", "POST")).not.toBe(404);
		});
	});

	describe("a reader who may view project P", () => {
		it("sees P's job in the list and among the project facets", async () => {
			const page = await readAs(VIEWER, () => readJobsPage({}));
			expect(ids(page.rows)).toEqual(
				expect.arrayContaining([seeded.jobP, seeded.jobQ, seeded.jobOrg, seeded.scanP, seeded.legacyScanP, seeded.legacyScanQ]),
			);
			expect(page.facets.projects.map((o) => o.value)).toContain(P);
		});

		it("sees P's job in the shell's job feed", async () => {
			expect(ids(await readAs(VIEWER, () => readRecentJobs()))).toContain(seeded.jobP);
		});

		it("gets its detail, status, plan result, log head and project list", async () => {
			expect(await readAs(VIEWER, () => readJob(seeded.jobP))).toMatchObject({ id: seeded.jobP, project_id: P });
			await expect(readAs(VIEWER, () => readJobStatus(seeded.jobP))).resolves.toMatchObject({ status: "SUCCESS" });
			await expect(readAs(VIEWER, () => readPlanResult(seeded.jobP))).resolves.toMatchObject({ status: "SUCCESS" });
			await expect(readAs(VIEWER, () => readJobLogsHead(seeded.jobP))).resolves.toEqual({ lines: [], lastId: 0 });
			expect(ids(await readAs(VIEWER, () => readProjectJobs(P)))).toContain(seeded.jobP);
		});

		it("is served the log stream of P's job", async () => {
			expect(await streamStatus(VIEWER, seeded.jobP)).toBe(200);
		});
	});

	// Last on purpose: it stamps the legacy scans seeded above, which the cases before it read unstamped.
	describe("the migrate-time backfill of a scan's project (programmables.sql)", () => {
		it("stamps a scan whose snapshot names a project of its own org, leaves the rest, and is idempotent", async () => {
			const file = readFileSync(fileURLToPath(new URL("../../lib/db/programmables.sql", import.meta.url)), "utf8");
			const head = "DO $$\nDECLARE moved BIGINT; left_alone BIGINT;";
			const start = file.indexOf(head);
			expect(start).toBeGreaterThan(-1);
			const end = file.indexOf("END $$;", start);
			expect(end).toBeGreaterThan(start);
			const backfill = file.slice(start, end + "END $$;".length);

			const db = getServiceDb();
			// A project of ANOTHER org, which a scan of ORG's snapshot names (a historical mis-filing).
			const OTHER = randomUUID();
			const R = randomUUID();
			await db.insert(organization).values({ id: OTHER, name: `it-6121-o-${OTHER.slice(0, 8)}` });
			await db.insert(projects).values({
				id: R,
				user_id: ADMIN,
				org_id: OTHER,
				project_name: `it-6121-r-${R.slice(0, 8)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			});
			try {
				const crossOrg = await seedJob(ADMIN, ORG, { job_type: "CHART_SCAN", project_id: null, config_snapshot: { project_id: R } });
				const namesNone = await seedJob(ADMIN, ORG, { job_type: "IAC_SCAN", project_id: null, config_snapshot: {} });
				// Outside the scan kinds the statement is narrowed to.
				const notAScan = await seedJob(ADMIN, ORG, { job_type: "AUDIT", project_id: null, config_snapshot: { project_id: P } });

				await db.execute(sql.raw(backfill));

				const columnOf = async (id: string) =>
					(await db.select({ project_id: jobs.project_id }).from(jobs).where(eq(jobs.id, id)))[0]?.project_id;
				expect(await columnOf(seeded.legacyScanP)).toBe(P);
				expect(await columnOf(seeded.legacyScanQ)).toBe(Q);
				expect(await columnOf(crossOrg)).toBeNull();
				expect(await columnOf(namesNone)).toBeNull();
				expect(await columnOf(notAScan)).toBeNull();

				// Idempotent: a second run changes nothing.
				const touched = [seeded.legacyScanP, seeded.legacyScanQ, crossOrg, namesNone, notAScan];
				const before = await db.select({ id: jobs.id, project_id: jobs.project_id, org_id: jobs.org_id }).from(jobs).where(inArray(jobs.id, touched));
				await db.execute(sql.raw(backfill));
				const again = await db.select({ id: jobs.id, project_id: jobs.project_id, org_id: jobs.org_id }).from(jobs).where(inArray(jobs.id, touched));
				expect(again).toEqual(expect.arrayContaining(before));
				expect(again).toHaveLength(before.length);

				// And the stamped scan stays hidden from the denied reader, now through its column.
				const page = await readAs(DENIED, () => readJobsPage({}));
				expect(ids(page.rows)).not.toContain(seeded.legacyScanP);
			} finally {
				await db.delete(jobs).where(inArray(jobs.org_id, [OTHER]));
				await db.delete(projects).where(eq(projects.id, R));
				await db.delete(organization).where(eq(organization.id, OTHER));
			}
		});
	});
});
