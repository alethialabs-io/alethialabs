// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the resource-count queries — the projects count, the project_cluster→projects
// org join, the spend sum, and the running-jobs concurrency gauge — against real Postgres.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, runners, projectCluster, projects } from "@/lib/db/schema";
import { queryResourceCounts, queryRunningJobs } from "@/lib/queries/usage-counts";
import { describeIfDb, seedManagedRunner } from "./db";

const ORG = randomUUID();
let runnerId: string;

describeIfDb("usage-counts queries", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		runnerId = await seedManagedRunner(`it-counts-${ORG.slice(0, 8)}`);

		const insertedProjects = await db
			.insert(projects)
			.values([
				{
					user_id: ORG,
					org_id: ORG,
					project_name: "p1",
					region: "eu-west-1",
					iac_version: "1.0.0",
					estimated_monthly_cost: 100,
				},
				{
					user_id: ORG,
					org_id: ORG,
					project_name: "p2",
					region: "eu-west-1",
					iac_version: "1.0.0",
					estimated_monthly_cost: 50,
				},
			])
			.returning({ id: projects.id });
		// One cluster under the first project → clusters: 1.
		await db.insert(projectCluster).values({ project_id: insertedProjects[0].id });

		// Two in-flight jobs (CLAIMED + PROCESSING) + one finished (excluded from concurrency).
		await db.insert(jobs).values([
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "CLAIMED", config_snapshot: {}, runner_id: runnerId },
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "PROCESSING", config_snapshot: {}, runner_id: runnerId },
			{ user_id: ORG, org_id: ORG, job_type: "PLAN", status: "SUCCESS", config_snapshot: {}, runner_id: runnerId },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		// project_cluster cascades when projects are deleted.
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await db.delete(runners).where(eq(runners.id, runnerId));
	});

	it("counts projects/clusters and sums spend for the org", async () => {
		const c = await queryResourceCounts(ORG);
		expect(c.projects).toBe(2);
		expect(c.clusters).toBe(1);
		expect(c.spendUnderManagement).toBeCloseTo(150);
	});

	it("counts only in-flight jobs for the concurrency gauge", async () => {
		expect(await queryRunningJobs(ORG)).toBe(2); // CLAIMED + PROCESSING, not SUCCESS
	});

	it("scopes strictly to the org (a different org sees nothing)", async () => {
		const other = await queryResourceCounts(randomUUID());
		expect(other).toEqual({ projects: 0, clusters: 0, spendUnderManagement: 0 });
	});
});
