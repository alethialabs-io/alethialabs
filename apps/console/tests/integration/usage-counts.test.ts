// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the resource-count queries — the projects count, the clusters-under-management count,
// the spend sum, and the running-jobs concurrency gauge — against real Postgres.
//
// #6122 (finding F005): "a cluster under management" has ONE definition
// (lib/queries/usage-counts.ts `managedClusterPredicate`), and the Usage page's count and the
// Clusters page's list (lib/rpc/procedures/clusters.ts `readClusters`) must agree on it. The matrix
// below seeds one cluster per lifecycle a row can be in, and asserts the count, the project count and
// the list name EXACTLY the same clusters.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// The list's PDP gate is the authz suite's subject; here every check is allowed, so what is compared
// is which ROWS the two readers take.
vi.mock("@/lib/authz", () => ({
	getPdp: () => ({ enforce: async () => undefined, can: async () => ({ allowed: true }) }),
}));

import { getServiceDb } from "@/lib/db";
import { jobs, projectCluster, projectEnvironments, projects, runners } from "@/lib/db/schema";
import type { ComponentStatus, ProjectStatus } from "@/lib/db/schema/enums";
import {
	managedClusterEnvJoin,
	managedClusterPredicate,
	queryProjectResourceCounts,
	queryResourceCounts,
	queryRunningJobs,
} from "@/lib/queries/usage-counts";
import { finalizeDeployment } from "@/lib/jobs/finalize-deployment";
import { readClusters } from "@/lib/rpc/procedures/clusters";
import { APP_ROLE_DISTINCT, describeIfDb, seedManagedRunner } from "./db";

const ORG = randomUUID();
/** A member of ORG reading it from a different personal scope: their own project lives at org_id = MEMBER. */
const MEMBER = randomUUID();
let runnerId: string;
let projectA: string;
let projectB: string;

/** One environment of a project and its cluster row, in a given lifecycle. */
interface Case {
	name: string;
	env: ProjectStatus;
	cluster: ComponentStatus;
	/** The environment carries a deploy stamp (`last_deployed_at`): it has a live deployment. */
	deployed: boolean;
	managed: boolean;
}

/**
 * The lifecycles a cluster row can sit in, and whether it is under management. Project A carries the
 * first six (one dedicated cluster per environment); project B the rest.
 */
const A_CASES: Case[] = [
	{ name: "prod", env: "ACTIVE", cluster: "ACTIVE", deployed: true, managed: true },
	{ name: "redeploying", env: "QUEUED", cluster: "ACTIVE", deployed: true, managed: true },
	{ name: "last-run-failed", env: "FAILED", cluster: "ACTIVE", deployed: true, managed: true },
	// A first deploy in flight runs nothing yet; a draft never deployed runs nothing.
	{ name: "first-deploy", env: "QUEUED", cluster: "PENDING", deployed: false, managed: false },
	{ name: "draft", env: "DRAFT", cluster: "PENDING", deployed: false, managed: false },
	{ name: "torn-down", env: "DESTROYED", cluster: "ACTIVE", deployed: true, managed: false },
];
const B_CASES: Case[] = [
	// A promotion re-writes the design (the row back at PENDING) and plans (the environment back to
	// DRAFT) over a cluster that is running.
	{ name: "promoted-into", env: "DRAFT", cluster: "PENDING", deployed: true, managed: true },
	// A plan moves a deployed environment back to DRAFT without touching what runs (env-status.ts).
	{ name: "replanned", env: "DRAFT", cluster: "ACTIVE", deployed: true, managed: true },
	// Torn down, then re-planned: the teardown cleared the stamp, so the stale ACTIVE row is not a cluster.
	{ name: "destroyed-then-replanned", env: "DRAFT", cluster: "ACTIVE", deployed: false, managed: false },
	{ name: "destroying", env: "DESTROYING", cluster: "ACTIVE", deployed: true, managed: true },
	{ name: "row-destroyed", env: "ACTIVE", cluster: "DESTROYED", deployed: true, managed: false },
];

/** Cluster row ids by case name. */
const clusterIds = new Map<string, string>();

/** Seeds one environment + cluster per case under `projectId`; the first environment is the default. */
async function seedCases(projectId: string, cases: Case[], owner: string = ORG): Promise<void> {
	const db = getServiceDb();
	for (const [i, c] of cases.entries()) {
		const [env] = await db
			.insert(projectEnvironments)
			.values({
				project_id: projectId,
				user_id: owner,
				name: c.name,
				status: c.env,
				is_default: i === 0,
				last_deployed_at: c.deployed ? new Date() : null,
			})
			.returning({ id: projectEnvironments.id });
		const [row] = await db
			.insert(projectCluster)
			.values({ project_id: projectId, environment_id: env.id, status: c.cluster, cluster_name: `it-${c.name}` })
			.returning({ id: projectCluster.id });
		clusterIds.set(c.name, row.id);
	}
}

/** The cluster ids of the cases under management. */
function managedIds(cases: Case[]): string[] {
	return cases.filter((c) => c.managed).map((c) => clusterIds.get(c.name) ?? "");
}

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
		projectA = insertedProjects[0].id;
		projectB = insertedProjects[1].id;
		await seedCases(projectA, A_CASES);
		await seedCases(projectB, B_CASES);

		// MEMBER's own personal-scope project, with a cluster under management in it. RLS's owner arm
		// admits it to MEMBER from ANY address; the ORG's count never contains it.
		const [personal] = await db
			.insert(projects)
			.values({ user_id: MEMBER, org_id: MEMBER, project_name: "personal", region: "eu-west-1", iac_version: "1.0.0" })
			.returning({ id: projects.id });
		await seedCases(personal.id, [{ name: "personal", env: "ACTIVE", cluster: "ACTIVE", deployed: true, managed: true }], MEMBER);

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
		// Environments and cluster rows cascade when the projects are deleted.
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await db.delete(projects).where(eq(projects.org_id, MEMBER));
		await db.delete(runners).where(eq(runners.id, runnerId));
	});

	it("the definition itself takes exactly the managed lifecycles", async () => {
		const rows = await getServiceDb()
			.select({ id: projectCluster.id })
			.from(projectCluster)
			.innerJoin(projectEnvironments, managedClusterEnvJoin())
			.where(and(eq(projectCluster.org_id, ORG), managedClusterPredicate()));
		expect(new Set(rows.map((r) => r.id))).toEqual(new Set([...managedIds(A_CASES), ...managedIds(B_CASES)]));
	});

	it("counts projects, clusters under management, and sums spend for the org", async () => {
		const c = await queryResourceCounts(ORG);
		expect(c.projects).toBe(2);
		expect(c.clusters).toBe(managedIds(A_CASES).length + managedIds(B_CASES).length);
		expect(c.spendUnderManagement).toBeCloseTo(150);
	});

	it("counts each project's clusters under management by the same definition", async () => {
		expect((await queryProjectResourceCounts(projectA)).clusters).toBe(managedIds(A_CASES).length);
		expect((await queryProjectResourceCounts(projectB)).clusters).toBe(managedIds(B_CASES).length);
	});

	it("the Clusters page lists exactly the clusters the Usage page counts (F005)", async () => {
		// UNFILTERED: the list scopes on the address's org itself, so it is compared whole.
		const listed = (await readClusters({ userId: ORG, orgId: ORG })).map((c) => c.project_cluster.id);
		expect(new Set(listed)).toEqual(new Set([...managedIds(A_CASES), ...managedIds(B_CASES)]));
		expect(listed).toHaveLength((await queryResourceCounts(ORG)).clusters);
	});

	it("a member reading the org from another personal scope (userId ≠ orgId) sees the org's count, not their own projects", async () => {
		const listed = (await readClusters({ userId: MEMBER, orgId: ORG })).map((c) => c.project_cluster.id);
		expect(listed).not.toContain(clusterIds.get("personal"));
		expect(new Set(listed)).toEqual(new Set([...managedIds(A_CASES), ...managedIds(B_CASES)]));
		expect(listed).toHaveLength((await queryResourceCounts(ORG)).clusters);
	});

	it("lists each cluster with its OWN environment's name and lifecycle", async () => {
		const byId = new Map(
			(await readClusters({ userId: ORG, orgId: ORG })).map((c) => [c.project_cluster.id, c]),
		);
		const failed = byId.get(clusterIds.get("last-run-failed") ?? "");
		expect([failed?.environment_stage, failed?.status, failed?.project_cluster.status]).toEqual([
			"last-run-failed",
			"FAILED",
			"ACTIVE",
		]);
	});

	it("counts only in-flight jobs for the concurrency gauge", async () => {
		expect(await queryRunningJobs(ORG)).toBe(2); // CLAIMED + PROCESSING, not SUCCESS
	});

	it("scopes strictly to the org (a different org sees nothing)", async () => {
		const other = await queryResourceCounts(randomUUID());
		expect(other).toEqual({ projects: 0, clusters: 0, spendUnderManagement: 0 });
	});

	it("another org's list never carries this org's clusters", async () => {
		// Meaningful only where the app role is RLS-bound (APP_ROLE_DISTINCT); the migration role
		// bypasses RLS and would see every org's rows.
		if (!APP_ROLE_DISTINCT) return;
		const OTHER = randomUUID();
		const foreign = (await readClusters({ userId: OTHER, orgId: OTHER })).map((c) => c.project_cluster.id);
		const mine = new Set(clusterIds.values());
		expect(foreign.filter((id) => mine.has(id))).toEqual([]);
	});
});

describeIfDb("a DESTROY success records the teardown the definition reads", () => {
	const TORN_ORG = randomUUID();
	let projectId = "";

	/** One environment with a live, deployed cluster, in `status`; returns the env and cluster ids. */
	async function liveEnv(name: string, status: ProjectStatus): Promise<{ env: string; cluster: string }> {
		const db = getServiceDb();
		const [env] = await db
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: TORN_ORG, name, status, is_default: name === "a", last_deployed_at: new Date() })
			.returning({ id: projectEnvironments.id });
		const [row] = await db
			.insert(projectCluster)
			.values({ project_id: projectId, environment_id: env.id, status: "ACTIVE", cluster_name: `it-${name}` })
			.returning({ id: projectCluster.id });
		return { env: env.id, cluster: row.id };
	}

	/** A successful DESTROY job on `environmentId`, finalized as the status route finalizes it. */
	async function destroySucceeded(environmentId: string): Promise<void> {
		const [job] = await getServiceDb()
			.insert(jobs)
			.values({
				user_id: TORN_ORG,
				org_id: TORN_ORG,
				project_id: projectId,
				environment_id: environmentId,
				job_type: "DESTROY",
				status: "SUCCESS",
				config_snapshot: {},
			})
			.returning({ id: jobs.id });
		await finalizeDeployment(job.id);
	}

	beforeAll(async () => {
		const [p] = await getServiceDb()
			.insert(projects)
			.values({ user_id: TORN_ORG, org_id: TORN_ORG, project_name: "torn", region: "eu-west-1", iac_version: "1.0.0" })
			.returning({ id: projects.id });
		projectId = p.id;
	});

	afterAll(async () => {
		await getServiceDb().delete(jobs).where(eq(jobs.org_id, TORN_ORG));
		await getServiceDb().delete(projects).where(eq(projects.org_id, TORN_ORG));
	});

	it("a torn-down environment stays out after a re-plan and a design write put its rows back", async () => {
		const { env, cluster } = await liveEnv("a", "DESTROYING");
		expect((await queryResourceCounts(TORN_ORG)).clusters).toBe(1);
		await destroySucceeded(env);

		const db = getServiceDb();
		const [row] = await db.select({ status: projectCluster.status }).from(projectCluster).where(eq(projectCluster.id, cluster));
		const [e] = await db
			.select({ stamp: projectEnvironments.last_deployed_at })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, env));
		expect([row.status, e.stamp]).toEqual(["DESTROYED", null]);

		// Re-planned (DRAFT) and its design re-written (the row back at PENDING): still not a cluster.
		await db.update(projectEnvironments).set({ status: "DRAFT" }).where(eq(projectEnvironments.id, env));
		await db.update(projectCluster).set({ status: "PENDING" }).where(eq(projectCluster.id, cluster));
		expect((await queryResourceCounts(TORN_ORG)).clusters).toBe(0);
	});

	it("a straggler DESTROY success after a redeploy erases nothing", async () => {
		const { env, cluster } = await liveEnv("b", "ACTIVE");
		await destroySucceeded(env);
		const [row] = await getServiceDb()
			.select({ status: projectCluster.status })
			.from(projectCluster)
			.where(eq(projectCluster.id, cluster));
		expect(row.status).toBe("ACTIVE");
		expect((await queryResourceCounts(TORN_ORG)).clusters).toBe(1);
	});
});
