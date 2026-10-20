// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { type SQL, and, count, eq, inArray, sql, sum } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { jobs, projectCluster, projectEnvironments, projects } from "@/lib/db/schema";

/**
 * WHAT "A CLUSTER UNDER MANAGEMENT" MEANS — the one definition the clusters list, the Usage page's
 * cluster count and the project Usage view's count all read (#6122, finding F005). Before it, the
 * count took every `project_cluster` row in the org (a draft's never-deployed row, a torn-down
 * environment's row, any environment) while the list took one row per project, from its DEFAULT
 * environment, and only when that environment was ACTIVE — so the Usage page said "1 cluster under
 * management" over a Clusters page that said "No clusters provisioned".
 *
 * A cluster is under management when its row's OWNING environment (`project_cluster.environment_id`)
 * has been sent to provision and has not been torn down:
 *
 *   · the environment is not DESTROYED, and the row is not DESTROYED;
 *   · and it is not a DRAFT that never deployed — a DRAFT environment whose cluster row is still the
 *     PENDING it was created with. (A plan re-computes an environment back to DRAFT without touching
 *     live infrastructure — lib/db/env-status.ts `planSuccess` — so a DRAFT environment whose cluster
 *     a deploy already moved past PENDING is still under management.)
 *
 * Every environment counts, not only the default one: a project with a dedicated staging and
 * production cluster runs two. A pending cluster (a deploy queued or in flight) and a failed one are
 * under management too; the list renders them as pending and failed rather than hiding them.
 *
 * The predicate reads `project_environments` joined on the CLUSTER's own environment — every caller
 * joins it with {@link managedClusterEnvJoin}. A row with no environment has no lifecycle to read and
 * is not counted.
 */
export function managedClusterPredicate(): SQL {
	return sql`(${projectCluster.status} <> 'DESTROYED'
		and ${projectEnvironments.status} <> 'DESTROYED'
		and (${projectEnvironments.status} <> 'DRAFT' or ${projectCluster.status} <> 'PENDING'))`;
}

/** The join condition every reader of {@link managedClusterPredicate} uses: the cluster's OWN environment. */
export function managedClusterEnvJoin(): SQL {
	return eq(projectEnvironments.id, projectCluster.environment_id);
}

/**
 * Point-in-time resource counts for one org — the "scale of what you run" row on the
 * Usage page. Service path with an explicit `org_id` filter (the service role bypasses
 * RLS, so the org scope is enforced here, mirroring getBillingSummary's member count).
 * `spendUnderManagement` is Σ of the projects' rolled-up monthly cost estimate — the basis
 * for a future FinOps fee, surfaced informationally today.
 */
export interface ResourceCounts {
	projects: number;
	/** Clusters under management across the org's projects ({@link managedClusterPredicate}). */
	clusters: number;
	/** Σ estimated monthly cloud cost across the org's projects (USD). */
	spendUnderManagement: number;
}

/** Counts projects and clusters under management, and sums estimated spend, for `orgId`. */
export async function queryResourceCounts(orgId: string): Promise<ResourceCounts> {
	const db = getServiceDb();
	const [projectRow, clusterRow] = await Promise.all([
		db
			.select({ n: count(), spend: sum(projects.estimated_monthly_cost) })
			.from(projects)
			.where(eq(projects.org_id, orgId)),
		// The tenancy boundary is the cluster row's own `org_id`, which the database keeps equal to its
		// project's (programmables.sql derive_component_org_id); the same column the CLI's cluster list
		// scopes on. What is counted is the shared definition.
		db
			.select({ n: count() })
			.from(projectCluster)
			.innerJoin(projectEnvironments, managedClusterEnvJoin())
			.where(and(eq(projectCluster.org_id, orgId), managedClusterPredicate())),
	]);

	return {
		projects: projectRow[0]?.n ?? 0,
		clusters: clusterRow[0]?.n ?? 0,
		spendUnderManagement: Number(projectRow[0]?.spend ?? 0),
	};
}

/** Point-in-time resource counts for one project — the project-scoped Usage view. */
export interface ProjectResourceCounts {
	/** Clusters under management in this project ({@link managedClusterPredicate}). */
	clusters: number;
	/** This project's estimated monthly cloud cost (USD). */
	estimatedMonthlyCost: number;
}

/**
 * Counts clusters under management and reads the estimated monthly cost for a single project — the
 * project analogue of {@link queryResourceCounts}. Clusters are scoped by
 * `project_cluster.project_id`; the cost is the project's own rolled-up estimate.
 * Service path with an explicit `project_id` filter (the caller verifies the project
 * belongs to the actor's org before calling).
 */
export async function queryProjectResourceCounts(
	projectId: string,
): Promise<ProjectResourceCounts> {
	const db = getServiceDb();
	const [clusterRow, projectRow] = await Promise.all([
		db
			.select({ n: count() })
			.from(projectCluster)
			.innerJoin(projectEnvironments, managedClusterEnvJoin())
			.where(and(eq(projectCluster.project_id, projectId), managedClusterPredicate())),
		db
			.select({ cost: projects.estimated_monthly_cost })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1),
	]);
	return {
		clusters: clusterRow[0]?.n ?? 0,
		estimatedMonthlyCost: Number(projectRow[0]?.cost ?? 0),
	};
}

/** Jobs currently in flight for a project (CLAIMED/PROCESSING) — the concurrency gauge. */
export async function queryProjectRunningJobs(projectId: string): Promise<number> {
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, projectId),
				inArray(jobs.status, ["CLAIMED", "PROCESSING"]),
			),
		);
	return row?.n ?? 0;
}

/** Jobs currently in flight for an org (CLAIMED/PROCESSING) — the concurrency gauge. */
export async function queryRunningJobs(orgId: string): Promise<number> {
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(jobs)
		.where(
			and(eq(jobs.org_id, orgId), inArray(jobs.status, ["CLAIMED", "PROCESSING"])),
		);
	return row?.n ?? 0;
}
