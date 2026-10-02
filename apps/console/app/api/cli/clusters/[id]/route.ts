// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { readKubeconfigAccess } from "@/lib/clusters/kubeconfig-access";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	projectCluster,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
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
 *
 * `kubeconfig` is `alethia cluster kubeconfig <selector>` plus, on aws/gcp/azure, the cloud-CLI
 * alternative — or a note saying why there is no command (#5250, #5322). It is built by `lib/clusters/kubeconfig-access.ts`, the same
 * module the console's cluster card renders, so the two surfaces cannot disagree.
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
				// Internal — the fallback cloud for the kubeconfig command when no deploy recorded one.
				// A cluster's own placement wins over the project's (NULL inherits).
				provider: cloudIdentities.provider,
			})
			.from(projectCluster)
			.innerJoin(projects, eq(projectCluster.project_id, projects.id))
			.leftJoin(
				cloudIdentities,
				eq(
					cloudIdentities.id,
					sql`coalesce(${projectCluster.cloud_identity_id}, ${projects.cloud_identity_id})`,
				),
			)
			.leftJoin(
				projectEnvironments,
				and(
					eq(projectEnvironments.project_id, projects.id),
					eq(projectEnvironments.is_default, true),
				),
			)
			.where(and(eq(projectCluster.id, id), eq(projectCluster.org_id, actor.orgId)))
			.limit(1);

		if (!row) {
			return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
		}

		const { project_id, environment_id, provider, ...clusterRow } = row;
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

		// Not best-effort, unlike gitops: it is one indexed read in the same database as the row
		// above, and a silently-absent command would read as "this cloud has none".
		const kubeconfig = await readKubeconfigAccess(getServiceDb(), {
			clusterId: cluster.id,
			projectId: project_id,
			environmentId: environment_id,
			clusterName: cluster.cluster_name,
			provider,
			region: cluster.region,
		});

		return cliJson(cliClusterDetailResponse, { cluster, gitops, kubeconfig });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
