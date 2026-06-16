"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createClient } from "@/lib/supabase/server";
import type { QueryData } from "@supabase/supabase-js";

/** Builds the clusters query — used to derive the return type via QueryData. */
function clustersQuery(supabase: Awaited<ReturnType<typeof createClient>>) {
	return supabase
		.from("vines")
		.select(
			`
			id, project_name, region, environment_stage, status,
			cloud_identities ( provider ),
			vine_cluster (
				cluster_name, cluster_endpoint, cluster_arn, cluster_version,
				argocd_url, argocd_admin_password, status
			),
			vine_databases (
				name, engine, endpoint, reader_endpoint,
				master_credentials_secret_arn, status
			),
			vine_caches (
				name, engine, endpoint, status
			),
			vine_dns (
				domain_name, enabled
			)
		`,
		)
		.eq("status", "ACTIVE")
		.order("created_at", { ascending: false });
}

type ClustersQueryRow = QueryData<ReturnType<typeof clustersQuery>>[number];

export type ClusterData = ClustersQueryRow;

/** Fetches all active vines with their cluster, database, cache, and DNS data. */
export async function getClusters(): Promise<ClusterData[]> {
	const supabase = await createClient();
	const { data, error } = await clustersQuery(supabase);
	if (error || !data) return [];
	return data;
}
