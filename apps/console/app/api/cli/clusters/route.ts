// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { projectCluster, projectEnvironments, projects } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliClustersResponse } from "@/lib/validations/cli-contract";

/**
 * Lists project_cluster data joined with the parent project's project_name for the
 * CLI user. Wire-locked: the flat `project_*` keys are the frozen CLI contract.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select({
				id: projectCluster.id,
				cluster_name: projectCluster.cluster_name,
				cluster_version: projectCluster.cluster_version,
				instance_types: projectCluster.instance_types,
				node_min_size: projectCluster.node_min_size,
				node_max_size: projectCluster.node_max_size,
				node_desired_size: projectCluster.node_desired_size,
				status: projectCluster.status,
				status_message: projectCluster.status_message,
				argocd_url: projectCluster.argocd_url,
				estimated_monthly_cost: projectCluster.estimated_monthly_cost,
				created_at: projectCluster.created_at,
				updated_at: projectCluster.updated_at,
				project_name: projects.project_name,
				// M1: the cluster's environment = the project's default environment name.
				environment: projectEnvironments.name,
				region: projects.region,
			})
			.from(projectCluster)
			.innerJoin(projects, eq(projectCluster.project_id, projects.id))
			.leftJoin(
				projectEnvironments,
				and(
					eq(projectEnvironments.project_id, projects.id),
					eq(projectEnvironments.is_default, true),
				),
			)
			.where(eq(projects.org_id, actor.orgId))
			.orderBy(desc(projectCluster.updated_at));

		const clusters = rows.map((r) => ({
			...r,
			environment: r.environment ?? "development",
		}));

		return cliJson(cliClustersResponse, { clusters });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
