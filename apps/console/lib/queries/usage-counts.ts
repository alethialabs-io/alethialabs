// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, count, eq, gte, inArray, lt, sum } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { jobs, projectCluster, projects } from "@/lib/db/schema";

/**
 * Point-in-time resource counts for one org — the "scale of what you run" row on the
 * Usage page. Service path with an explicit `org_id` filter (the service role bypasses
 * RLS, so the org scope is enforced here, mirroring getBillingSummary's member count).
 * `spendUnderManagement` is Σ of the projects' rolled-up monthly cost estimate — the basis
 * for a future FinOps fee, surfaced informationally today.
 */
export interface ResourceCounts {
	projects: number;
	/** Provisioned cluster components across the org's projects. */
	clusters: number;
	/** Σ estimated monthly cloud cost across the org's projects (USD). */
	spendUnderManagement: number;
}

/** Counts projects (projects)/clusters and sums estimated spend for `orgId`. */
export async function queryResourceCounts(orgId: string): Promise<ResourceCounts> {
	const db = getServiceDb();
	const [projectRow, clusterRow] = await Promise.all([
		db
			.select({ n: count(), spend: sum(projects.estimated_monthly_cost) })
			.from(projects)
			.where(eq(projects.org_id, orgId)),
		// Clusters live under projects (project_id), not org-scoped directly — join to scope.
		db
			.select({ n: count() })
			.from(projectCluster)
			.innerJoin(projects, eq(projectCluster.project_id, projects.id))
			.where(eq(projects.org_id, orgId)),
	]);

	return {
		projects: projectRow[0]?.n ?? 0,
		clusters: clusterRow[0]?.n ?? 0,
		spendUnderManagement: Number(projectRow[0]?.spend ?? 0),
	};
}

/** Jobs an org ran in a window (by creation time) — the cumulative "Jobs" counter. */
export async function queryJobCount(
	orgId: string,
	from: Date,
	to: Date,
): Promise<number> {
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(jobs)
		.where(
			and(
				eq(jobs.org_id, orgId),
				gte(jobs.created_at, from),
				lt(jobs.created_at, to),
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
