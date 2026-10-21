// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Job and project reads in the single-tenant (community) edition.
//
// The `owner_all` policy on `projects` and `jobs` admits a row whose `org_id` is the request's org
// or the caller's personal org. Community resolves every actor to the personal scope
// (`getActiveScope` → `orgId = userId`), and the create paths stamp the scope's org, so every row a
// community user writes carries `org_id = <their id>` — inside the policy — even though signup also
// provisions a real `organization` row for them (lib/auth/onboarding.ts provisionPrimaryOrg). This
// drives that through the real scope resolver, the shared project-create core and the insert
// triggers, then reads back through the server actions on the RLS-enforced app role.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
	const was = process.env.ALETHIA_EDITION;
	process.env.ALETHIA_EDITION = "community";
	return { was };
});

vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": "/" }),
	cookies: async () => ({ get: () => undefined }),
}));

import { rerunJob } from "@/app/server/actions/jobs";
import { RERUN_FROM_PROJECT, RERUN_FROM_RUNNER } from "@/lib/jobs/operation";
import { readJob, readJobsPage } from "@/lib/rpc/procedures/jobs";
import { getProject, getProjectsList } from "@/app/server/actions/projects";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb, withActorScope } from "@/lib/db";
import { grants, jobs, member, organization, projects, user } from "@/lib/db/schema";
import { getEnterprise } from "@/lib/enterprise";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import { describeIfDb } from "./db";

const U = randomUUID();
const PRIMARY = randomUUID(); // the real organization row signup provisions

let actor: Actor = { userId: U, orgId: "" };
let projectId = "";
let projectJob = "";
let runnerJob = "";

describeIfDb("job and project reads in the single-tenant edition", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values({ id: U, email: `c-${U}@example.test` });
		await db.insert(organization).values([
			{ id: PRIMARY, name: `c-${PRIMARY.slice(0, 8)}`, slug: `c-${PRIMARY.slice(0, 8)}` },
			{ id: U, name: `c-personal-${U.slice(0, 8)}` },
		]);
		await db.insert(member).values({ organizationId: PRIMARY, userId: U, role: "owner" });
		for (const org of [PRIMARY, U]) {
			await db.insert(grants).values({
				org_id: org,
				principal_type: "user",
				principal_id: U,
				effect: "allow",
				role_id: BUILTIN_ROLE_IDS.owner,
				resource_type: "org",
				resource_id: null,
			});
		}

		// The real resolver, asked for the real org: community answers with the personal scope.
		actor = await getActiveScope(U, PRIMARY);

		// The shared create core (the console action and the CLI route both run it), then two jobs
		// that leave org_id to the insert trigger: one from the project, one from the session.
		const created = await withActorScope(actor, (tx) =>
			insertProjectWithDefaultFabric(tx, {
				project_name: `c-${U.slice(0, 6)}`,
				region: "us-east-1",
				iac_version: "1.9.5",
				environment_stage: "production",
				owner: U,
				orgId: actor.orgId,
			}),
		);
		projectId = created.project.id;
		const [pj, rj] = await withActorScope(actor, (tx) =>
			tx
				.insert(jobs)
				.values([
					{
						user_id: U,
						project_id: projectId,
						environment_id: created.defaultEnv.id,
						job_type: "DETECT_DRIFT",
						status: "SUCCESS",
						config_snapshot: {},
					},
					{ user_id: U, job_type: "DEPLOY_RUNNER", status: "SUCCESS", config_snapshot: {} },
				])
				.returning({ id: jobs.id }),
		);
		projectJob = pj.id;
		runnerJob = rj.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.org_id, U));
		await db.delete(projects).where(eq(projects.org_id, U));
		await db.delete(grants).where(inArray(grants.org_id, [PRIMARY, U]));
		await db.delete(member).where(eq(member.organizationId, PRIMARY));
		if (env.was === undefined) delete process.env.ALETHIA_EDITION;
		else process.env.ALETHIA_EDITION = env.was;
	});

	it("resolves the actor to the personal scope", () => {
		expect(getEnterprise()).toBeNull();
		expect(actor.orgId).toBe(U);
	});

	it("stamps the project and both jobs with the user's own id as their org", async () => {
		const [p] = await getServiceDb()
			.select({ org_id: projects.org_id })
			.from(projects)
			.where(eq(projects.id, projectId));
		expect(p.org_id).toBe(U);
		const rows = await getServiceDb()
			.select({ org_id: jobs.org_id })
			.from(jobs)
			.where(inArray(jobs.id, [projectJob, runnerJob]));
		expect(rows.map((r) => r.org_id)).toEqual([U, U]);
	});

	it("lists and opens the user's own jobs and project", async () => {
		const page = await runWithActor(actor, () => readJobsPage({}));
		const ids = page.rows.map((r) => r.id);
		expect(ids).toContain(projectJob);
		expect(ids).toContain(runnerJob);
		expect((await runWithActor(actor, () => readJob(projectJob)))?.id).toBe(projectJob);
		const list = await runWithActor(actor, () => getProjectsList());
		expect(list.projects.some((p) => p.id === projectId)).toBe(true);
		const opened = await runWithActor(actor, () => getProject(projectId));
		expect(opened.project.id).toBe(projectId);
	});

	it("re-runs a job into the same personal org", async () => {
		// Only an allow-listed kind is re-queued as a copy (lib/jobs/operation.ts): an org-level AUDIT.
		const [audit] = await withActorScope(actor, (tx) =>
			tx
				.insert(jobs)
				.values({ user_id: U, job_type: "AUDIT", status: "SUCCESS", config_snapshot: {} })
				.returning({ id: jobs.id }),
		);
		const result = await runWithActor(actor, () => rerunJob({ jobId: audit.id }));
		if (!result.ok) throw new Error(`re-run refused: ${JSON.stringify(result.error)}`);
		const [row] = await getServiceDb()
			.select({ org_id: jobs.org_id, project_id: jobs.project_id })
			.from(jobs)
			.where(eq(jobs.id, result.data.id));
		expect(row).toEqual({ org_id: U, project_id: null });
	});

	it("does not copy a runner's lifecycle job — that runs again from the runner", async () => {
		expect(await runWithActor(actor, () => rerunJob({ jobId: runnerJob }))).toEqual({
			ok: false,
			error: { kind: "conflict", message: RERUN_FROM_RUNNER },
		});
	});

	it("does not re-run a project's drift check from the job — that runs again from the project", async () => {
		expect(await runWithActor(actor, () => rerunJob({ jobId: projectJob }))).toEqual({
			ok: false,
			error: { kind: "conflict", message: RERUN_FROM_PROJECT },
		});
	});
});
