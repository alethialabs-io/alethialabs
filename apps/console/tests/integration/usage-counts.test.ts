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
import { readClusters } from "@/lib/rpc/procedures/clusters";
import { APP_ROLE_DISTINCT, describeIfDb, seedManagedRunner } from "./db";

const ORG = randomUUID();
let runnerId: string;
let projectA: string;
let projectB: string;

/** One environment of a project and its cluster row, in a given lifecycle. */
interface Case {
	name: string;
	env: ProjectStatus;
	cluster: ComponentStatus;
	managed: boolean;
}

/**
 * Every lifecycle a cluster row can sit in, and whether it is under management. Project A carries the
 * first five (one dedicated cluster per environment); project B the rest.
 */
const A_CASES: Case[] = [
	{ name: "prod", env: "ACTIVE", cluster: "ACTIVE", managed: true },
	{ name: "queued", env: "QUEUED", cluster: "PENDING", managed: true },
	{ name: "failed", env: "FAILED", cluster: "PENDING", managed: true },
	{ name: "draft", env: "DRAFT", cluster: "PENDING", managed: false },
	{ name: "torn-down", env: "DESTROYED", cluster: "ACTIVE", managed: false },
];
const B_CASES: Case[] = [
	// A plan moves an environment back to DRAFT without touching what is deployed (env-status.ts).
	{ name: "replanned", env: "DRAFT", cluster: "ACTIVE", managed: true },
	{ name: "destroying", env: "DESTROYING", cluster: "ACTIVE", managed: true },
	{ name: "row-destroyed", env: "ACTIVE", cluster: "DESTROYED", managed: false },
];

/** Cluster row ids by case name. */
const clusterIds = new Map<string, string>();

/** Seeds one environment + cluster per case under `projectId`; the first environment is the default. */
async function seedCases(projectId: string, cases: Case[]): Promise<void> {
	const db = getServiceDb();
	for (const [i, c] of cases.entries()) {
		const [env] = await db
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: ORG, name: c.name, status: c.env, is_default: i === 0 })
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
		// The list runs on the RLS role scoped to ORG; where the app role bypasses RLS it could also
		// see other suites' rows, so only this org's projects are compared.
		const listed = (await readClusters({ userId: ORG, orgId: ORG }))
			.filter((c) => c.id === projectA || c.id === projectB)
			.map((c) => c.project_cluster.id);
		expect(new Set(listed)).toEqual(new Set([...managedIds(A_CASES), ...managedIds(B_CASES)]));
		expect(listed).toHaveLength((await queryResourceCounts(ORG)).clusters);
	});

	it("lists each cluster with its OWN environment's name and lifecycle", async () => {
		const byId = new Map(
			(await readClusters({ userId: ORG, orgId: ORG })).map((c) => [c.project_cluster.id, c]),
		);
		const failed = byId.get(clusterIds.get("failed") ?? "");
		expect([failed?.environment_stage, failed?.status, failed?.project_cluster.status]).toEqual([
			"failed",
			"FAILED",
			"PENDING",
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
