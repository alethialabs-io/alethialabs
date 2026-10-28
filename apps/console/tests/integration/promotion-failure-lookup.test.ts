// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: `failPromotionForJob` (lib/promotions/lifecycle.ts) fails EXACTLY the promotion whose
// job failed, against real Postgres (#6228).
//
// The lookup used to take ONE in-flight promotion with `LIMIT 1` across every project and only then
// compare its job ids. With two promotions in flight the row it took was usually the other one, so
// the failing promotion stayed in flight and held its target's one-active-promotion slot
// (`env_promotions_one_active_per_target`) — every later promotion into that environment was refused.
// A mocked query builder cannot show that: the bug was in which row the database hands back.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { environmentPromotions, jobs, projectEnvironments, projects } from "@/lib/db/schema";
import { failPromotionForJob } from "@/lib/promotions/lifecycle";
import { describeIfDb } from "./db";

type PromotionStatus = typeof environmentPromotions.$inferSelect.status;

/** Seeds a project owned by `owner` with a source env and `targets` target envs; returns their ids. */
async function seedProject(
	owner: string,
	targets: number,
): Promise<{ projectId: string; sourceId: string; targetIds: string[] }> {
	const db = getServiceDb();
	const [p] = await db
		.insert(projects)
		.values({
			user_id: owner,
			org_id: owner,
			project_name: `promo-fail-${owner.slice(0, 8)}`,
			region: "us-east-1",
			iac_version: "1.9.5",
		})
		.returning({ id: projects.id });
	const [src] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: owner, name: "dev", status: "ACTIVE", is_default: true })
		.returning({ id: projectEnvironments.id });
	const targetIds: string[] = [];
	for (let i = 0; i < targets; i++) {
		const [t] = await db
			.insert(projectEnvironments)
			.values({
				project_id: p.id,
				user_id: owner,
				name: `target-${i}`,
				status: "ACTIVE",
				is_default: false,
			})
			.returning({ id: projectEnvironments.id });
		targetIds.push(t.id);
	}
	return { projectId: p.id, sourceId: src.id, targetIds };
}

/** Inserts a PLAN job for `projectId`/`environmentId`; returns its id. */
async function seedPlanJob(owner: string, projectId: string, environmentId: string): Promise<string> {
	const [j] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: owner,
			org_id: owner,
			project_id: projectId,
			environment_id: environmentId,
			job_type: "PLAN",
			status: "PROCESSING",
		})
		.returning({ id: jobs.id });
	return j.id;
}

/** Inserts a promotion source→target backed by `planJobId`, in `status`; returns its id. */
async function seedPromotion(
	owner: string,
	projectId: string,
	sourceId: string,
	targetId: string,
	planJobId: string,
	status: PromotionStatus,
): Promise<string> {
	const [promo] = await getServiceDb()
		.insert(environmentPromotions)
		.values({
			project_id: projectId,
			user_id: owner,
			org_id: owner,
			source_environment_id: sourceId,
			target_environment_id: targetId,
			plan_job_id: planJobId,
			status,
		})
		.returning({ id: environmentPromotions.id });
	return promo.id;
}

/** A promotion's status, freshly read. */
async function statusOf(promotionId: string): Promise<PromotionStatus | undefined> {
	const [row] = await getServiceDb()
		.select({ status: environmentPromotions.status })
		.from(environmentPromotions)
		.where(eq(environmentPromotions.id, promotionId));
	return row?.status;
}

describeIfDb("failPromotionForJob — fails the failed job's own promotion (#6228)", () => {
	const seededProjects: string[] = [];
	const seededJobs: string[] = [];

	afterEach(async () => {
		const db = getServiceDb();
		// jobs.project_id is ON DELETE SET NULL, so the jobs go explicitly; promotions and
		// environments cascade off the project.
		if (seededJobs.length) await db.delete(jobs).where(inArray(jobs.id, seededJobs));
		if (seededProjects.length) await db.delete(projects).where(inArray(projects.id, seededProjects));
		seededJobs.length = 0;
		seededProjects.length = 0;
	});

	it("with two promotions in flight, fails the second one's promotion and leaves the first untouched", async () => {
		const owner = randomUUID();
		const { projectId, sourceId, targetIds } = await seedProject(owner, 2);
		seededProjects.push(projectId);
		const jobA = await seedPlanJob(owner, projectId, targetIds[0]);
		const jobB = await seedPlanJob(owner, projectId, targetIds[1]);
		seededJobs.push(jobA, jobB);
		// Inserted first, so it is the row a bare LIMIT 1 over the in-flight set comes back with.
		const promoA = await seedPromotion(owner, projectId, sourceId, targetIds[0], jobA, "PENDING_PLAN");
		const promoB = await seedPromotion(owner, projectId, sourceId, targetIds[1], jobB, "PENDING_PLAN");

		await failPromotionForJob(jobB);

		expect(await statusOf(promoB)).toBe("FAILED");
		expect(await statusOf(promoA)).toBe("PENDING_PLAN");

		// And the failed promotion released its target's slot: a new promotion into it is accepted.
		const jobC = await seedPlanJob(owner, projectId, targetIds[1]);
		seededJobs.push(jobC);
		const promoC = await seedPromotion(owner, projectId, sourceId, targetIds[1], jobC, "PENDING_PLAN");
		expect(await statusOf(promoC)).toBe("PENDING_PLAN");
	});

	it("fails a promotion by its DEPLOY job too", async () => {
		const owner = randomUUID();
		const { projectId, sourceId, targetIds } = await seedProject(owner, 2);
		seededProjects.push(projectId);
		const planA = await seedPlanJob(owner, projectId, targetIds[0]);
		const planB = await seedPlanJob(owner, projectId, targetIds[1]);
		const deployB = await seedPlanJob(owner, projectId, targetIds[1]);
		seededJobs.push(planA, planB, deployB);
		const promoA = await seedPromotion(owner, projectId, sourceId, targetIds[0], planA, "DEPLOYING");
		const promoB = await seedPromotion(owner, projectId, sourceId, targetIds[1], planB, "DEPLOYING");
		await getServiceDb()
			.update(environmentPromotions)
			.set({ deploy_job_id: deployB })
			.where(eq(environmentPromotions.id, promoB));

		await failPromotionForJob(deployB);

		expect(await statusOf(promoB)).toBe("FAILED");
		expect(await statusOf(promoA)).toBe("DEPLOYING");
	});

	it("never fails a promotion of another project that names the same job", async () => {
		const ownerX = randomUUID();
		const ownerY = randomUUID();
		const x = await seedProject(ownerX, 1);
		const y = await seedProject(ownerY, 1);
		seededProjects.push(x.projectId, y.projectId);
		const jobX = await seedPlanJob(ownerX, x.projectId, x.targetIds[0]);
		seededJobs.push(jobX);
		const promoX = await seedPromotion(ownerX, x.projectId, x.sourceId, x.targetIds[0], jobX, "PENDING_PLAN");
		// A row of ANOTHER organization's project pointing at project X's job: the lookup is bound to
		// the job's own project, so it is not reachable through X's job.
		const promoY = await seedPromotion(ownerY, y.projectId, y.sourceId, y.targetIds[0], jobX, "PENDING_PLAN");

		await failPromotionForJob(jobX);

		expect(await statusOf(promoX)).toBe("FAILED");
		expect(await statusOf(promoY)).toBe("PENDING_PLAN");
	});

	it("does not rewrite a promotion that already left the in-flight states", async () => {
		const owner = randomUUID();
		const { projectId, sourceId, targetIds } = await seedProject(owner, 1);
		seededProjects.push(projectId);
		const job = await seedPlanJob(owner, projectId, targetIds[0]);
		seededJobs.push(job);
		const promo = await seedPromotion(owner, projectId, sourceId, targetIds[0], job, "SUCCEEDED");

		await failPromotionForJob(job);

		expect(await statusOf(promo)).toBe("SUCCEEDED");
	});

	it("is a no-op for a job that backs no promotion", async () => {
		const owner = randomUUID();
		const { projectId, sourceId, targetIds } = await seedProject(owner, 1);
		seededProjects.push(projectId);
		const backing = await seedPlanJob(owner, projectId, targetIds[0]);
		const unrelated = await seedPlanJob(owner, projectId, targetIds[0]);
		seededJobs.push(backing, unrelated);
		const promo = await seedPromotion(owner, projectId, sourceId, targetIds[0], backing, "PENDING_PLAN");

		await failPromotionForJob(unrelated);
		await failPromotionForJob(randomUUID());

		expect(await statusOf(promo)).toBe("PENDING_PLAN");
	});
});
