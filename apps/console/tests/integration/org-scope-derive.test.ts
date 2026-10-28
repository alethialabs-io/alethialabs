// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the org_id derive-and-store invariant for jobs (the fix for org-scoped usage/
// clusters reading empty in Teams orgs). A job ALWAYS belongs to the org that owns its project,
// so the set_org_id_from_project trigger derives jobs.org_id from projects.org_id when the insert
// leaves it empty, and refuses an explicit org_id that disagrees — structurally, independent of
// what the insert call-site remembered to stamp. Regression cover for the bug where
// job inserts omitted org_id and the old trigger silently collapsed it to user_id, so org reads
// filtering jobs.org_id missed every job in a real (org_id !== user_id) organization.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, projects, runners } from "@/lib/db/schema";
import { describeIfDb, seedManagedRunner } from "./db";

// A Teams org: the organization id is DISTINCT from the creating user's id (the case the old
// trigger got wrong; community collapses the two so it never reproduced there).
const ORG = randomUUID();
const USER = randomUUID();
let runnerId: string;
let projectId: string;

describeIfDb("jobs.org_id derive-and-store (Teams org)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		runnerId = await seedManagedRunner(`it-derive-${ORG.slice(0, 8)}`);
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG, // project correctly stamped with the real org (createProject does this)
				project_name: "derive-p",
				region: "eu-west-1",
				iac_version: "1.0.0",
			})
			.returning({ id: projects.id });
		projectId = p.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.project_id, projectId));
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await db.delete(runners).where(eq(runners.id, runnerId));
	});

	it("derives org_id from the project's org when the insert omits it", async () => {
		const db = getServiceDb();
		// Mirrors the real provisioning inserts (projects.ts et al.): user_id + project_id, NO org_id.
		const [job] = await db
			.insert(jobs)
			.values({
				user_id: USER,
				project_id: projectId,
				job_type: "PLAN",
				status: "QUEUED",
				config_snapshot: {},
				runner_id: runnerId,
			})
			.returning({ org_id: jobs.org_id });
		expect(job.org_id).toBe(ORG); // the project's org…
		expect(job.org_id).not.toBe(USER); // …NOT the creator's personal id (the old bug)
	});

	it("falls back to user_id for a project-less job (runner/scan work)", async () => {
		const db = getServiceDb();
		const [job] = await db
			.insert(jobs)
			.values({
				user_id: USER,
				job_type: "DEPLOY_RUNNER",
				status: "QUEUED",
				config_snapshot: {},
				runner_id: runnerId,
			})
			.returning({ org_id: jobs.org_id });
		expect(job.org_id).toBe(USER); // no project → personal org (community-equivalent)
	});

	it("an explicit org_id is kept when it is the project's org, and refused when it is not", async () => {
		const db = getServiceDb();
		const [kept] = await db
			.insert(jobs)
			.values({
				user_id: USER,
				org_id: ORG,
				project_id: projectId,
				job_type: "PLAN",
				status: "QUEUED",
				config_snapshot: {},
				runner_id: runnerId,
			})
			.returning({ org_id: jobs.org_id });
		expect(kept.org_id).toBe(ORG);

		await expect(
			db.insert(jobs).values({
				user_id: USER,
				org_id: randomUUID(),
				project_id: projectId,
				job_type: "PLAN",
				status: "QUEUED",
				config_snapshot: {},
				runner_id: runnerId,
			}),
		).rejects.toMatchObject({ cause: { code: "23514" } });

		// A project-less job keeps its explicit org: there is no parent to agree with.
		const explicit = randomUUID();
		const [projectless] = await db
			.insert(jobs)
			.values({
				user_id: USER,
				org_id: explicit,
				job_type: "DEPLOY_RUNNER",
				status: "QUEUED",
				config_snapshot: {},
				runner_id: runnerId,
			})
			.returning({ org_id: jobs.org_id });
		expect(projectless.org_id).toBe(explicit);
	});

	it("every project job carries its project's org (invariant): the NULL-org backfill fills it", async () => {
		const db = getServiceDb();
		// A historical row with no org (triggers off for the one write: the trigger would fill it).
		const [legacy] = await db.transaction(async (tx) => {
			await tx.execute(sql`set local session_replication_role = replica`);
			return tx
				.insert(jobs)
				.values({
					user_id: USER,
					project_id: projectId,
					job_type: "PLAN",
					status: "SUCCESS",
					config_snapshot: {},
					runner_id: runnerId,
				})
				.returning({ id: jobs.id, org_id: jobs.org_id });
		});
		expect(legacy.org_id).toBeNull();

		// The backfill statement from programmables.sql, project-scoped here.
		await db.execute(sql`
			UPDATE public.jobs j
			   SET org_id = p.org_id
			  FROM public.projects p
			 WHERE j.project_id = p.id
			   AND j.project_id = ${projectId}
			   AND j.org_id IS NULL
			   AND p.org_id IS NOT NULL`);

		const rows = await db
			.select({ org_id: jobs.org_id })
			.from(jobs)
			.where(eq(jobs.project_id, projectId));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.org_id === ORG)).toBe(true);
	});
});
