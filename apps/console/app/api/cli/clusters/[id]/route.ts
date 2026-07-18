// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectCluster, projectEnvironments, projects } from "@/lib/db/schema";
import { readGitopsDeployStatus } from "@/lib/gitops/deploy-status";
import {
	cliClusterDetailResponse,
	type clusterGitops,
} from "@/lib/validations/cli-contract";

/**
 * One project cluster (by `project_cluster` id) plus its compact ArgoCD/GitOps posture —
 * the backing route for `alethia cluster get`. GitOps is best-effort: a read failure yields
 * `null` (the CLI renders "unknown") rather than failing the whole request. Wire-locked to
 * `cliClusterDetailResponse`; org-scoped like the list route.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const [row] = await getServiceDb()
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
				environment: projectEnvironments.name,
				region: projects.region,
				// Internal — used for the gitops read, stripped from the response.
				project_id: projectCluster.project_id,
				environment_id: projectCluster.environment_id,
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
			.where(and(eq(projectCluster.id, id), eq(projects.org_id, actor.orgId)))
			.limit(1);

		if (!row) {
			return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
		}

		const { project_id, environment_id, ...clusterRow } = row;
		const cluster = {
			...clusterRow,
			environment: clusterRow.environment ?? "development",
		};

		// Best-effort GitOps posture — never fail the request on a read error.
		let gitops: z.infer<typeof clusterGitops> | null = null;
		try {
			if (environment_id) {
				const g = await readGitopsDeployStatus(project_id, environment_id);
				const all = [...g.services, ...g.addons, ...g.dataServices];
				gitops = {
					mode: g.mode,
					apps_repo: g.appsRepo,
					revision: g.revision,
					total: all.length,
					synced: all.filter((r) => r.sync === "Synced").length,
					healthy: all.filter((r) => r.health === "Healthy").length,
					status_available: g.statusAvailable,
					last_deploy_failed: g.lastDeployFailed,
					failed_step: g.failedStep,
					failure_message: g.failureMessage,
				};
			}
		} catch {
			gitops = null;
		}

		return cliJson(cliClusterDetailResponse, { cluster, gitops });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
