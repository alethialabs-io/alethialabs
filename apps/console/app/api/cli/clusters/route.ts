// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { desc, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { specCluster, specs } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliClustersResponse } from "@/lib/validations/cli-contract";

/**
 * Lists spec_cluster data joined with the parent spec's project_name for the
 * CLI user. Wire-locked: the flat `spec_*` keys are the frozen CLI contract.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "spec" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select({
				id: specCluster.id,
				cluster_name: specCluster.cluster_name,
				cluster_version: specCluster.cluster_version,
				instance_types: specCluster.instance_types,
				node_min_size: specCluster.node_min_size,
				node_max_size: specCluster.node_max_size,
				node_desired_size: specCluster.node_desired_size,
				status: specCluster.status,
				status_message: specCluster.status_message,
				argocd_url: specCluster.argocd_url,
				estimated_monthly_cost: specCluster.estimated_monthly_cost,
				created_at: specCluster.created_at,
				updated_at: specCluster.updated_at,
				spec_project_name: specs.project_name,
				spec_environment: specs.environment_stage,
				spec_region: specs.region,
			})
			.from(specCluster)
			.innerJoin(specs, eq(specCluster.spec_id, specs.id))
			.where(eq(specs.org_id, actor.orgId))
			.orderBy(desc(specCluster.updated_at));

		return cliJson(cliClustersResponse, { clusters: rows });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
