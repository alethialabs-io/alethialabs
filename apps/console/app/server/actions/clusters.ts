"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, inArray } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import {
	cloudIdentities,
	projectCaches,
	projectCluster,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";

export interface ClusterData {
	id: string;
	project_name: string;
	region: string;
	environment_stage: string;
	status: string;
	cloud_identities: { provider: string } | null;
	project_cluster: {
		cluster_name: string | null;
		cluster_endpoint: string | null;
		cluster_arn: string | null;
		cluster_version: string | null;
		argocd_url: string | null;
		argocd_admin_password: string | null;
		status: string;
	} | null;
	project_databases: {
		name: string;
		engine: string | null;
		endpoint: string | null;
		reader_endpoint: string | null;
		master_credentials_secret_arn: string | null;
		status: string;
	}[];
	project_caches: {
		name: string;
		engine: string | null;
		endpoint: string | null;
		status: string;
	}[];
	project_dns: { domain_name: string | null; enabled: boolean } | null;
}

/** Fetches all active projects with their cluster, database, cache, and DNS data. */
export async function getClusters(): Promise<ClusterData[]> {
	const owner = await getOwner();
	if (!owner) return [];

	return withOwnerScope(owner, async (tx) => {
		// Project + to-one relations (cloud identity, cluster, dns) in one pass.
		const baseRows = await tx
			.select({
				id: projects.id,
				project_name: projects.project_name,
				region: projects.region,
				// M1: environment + status from the project's default environment.
				environment_stage: projectEnvironments.name,
				status: projectEnvironments.status,
				provider: cloudIdentities.provider,
				cluster_name: projectCluster.cluster_name,
				cluster_endpoint: projectCluster.cluster_endpoint,
				cluster_outputs: projectCluster.provider_outputs,
				cluster_version: projectCluster.cluster_version,
				argocd_url: projectCluster.argocd_url,
				argocd_admin_password: projectCluster.argocd_admin_password,
				cluster_status: projectCluster.status,
				dns_domain_name: projectDns.domain_name,
				dns_enabled: projectDns.enabled,
			})
			.from(projects)
			.leftJoin(cloudIdentities, eq(projects.cloud_identity_id, cloudIdentities.id))
			.leftJoin(
				projectEnvironments,
				and(
					eq(projectEnvironments.project_id, projects.id),
					eq(projectEnvironments.is_default, true),
				),
			)
			.leftJoin(projectCluster, eq(projectCluster.project_id, projects.id))
			.leftJoin(projectDns, eq(projectDns.project_id, projects.id))
			.where(eq(projectEnvironments.status, "ACTIVE"))
			.orderBy(desc(projects.created_at));

		if (baseRows.length === 0) return [];

		const projectIds = baseRows.map((r) => r.id);

		// To-many relations fetched in bulk, then grouped by project.
		const [dbRows, cacheRows] = await Promise.all([
			tx
				.select({
					project_id: projectDatabases.project_id,
					name: projectDatabases.name,
					engine: projectDatabases.engine,
					endpoint: projectDatabases.endpoint,
					reader_endpoint: projectDatabases.reader_endpoint,
					provider_outputs: projectDatabases.provider_outputs,
					status: projectDatabases.status,
				})
				.from(projectDatabases)
				.where(inArray(projectDatabases.project_id, projectIds)),
			tx
				.select({
					project_id: projectCaches.project_id,
					name: projectCaches.name,
					engine: projectCaches.engine,
					endpoint: projectCaches.endpoint,
					status: projectCaches.status,
				})
				.from(projectCaches)
				.where(inArray(projectCaches.project_id, projectIds)),
		]);

		return baseRows.map((r) => ({
			id: r.id,
			project_name: r.project_name,
			region: r.region,
			environment_stage: r.environment_stage ?? "development",
			status: r.status ?? "ACTIVE",
			cloud_identities: r.provider ? { provider: r.provider } : null,
			project_cluster: r.cluster_status
				? {
						cluster_name: r.cluster_name,
						cluster_endpoint: r.cluster_endpoint,
						cluster_arn: r.cluster_outputs?.arn ?? null,
						cluster_version: r.cluster_version,
						argocd_url: r.argocd_url,
						argocd_admin_password: r.argocd_admin_password,
						status: r.cluster_status,
					}
				: null,
			project_databases: dbRows
				.filter((d) => d.project_id === r.id)
				.map(({ project_id: _s, provider_outputs, ...db }) => ({
					...db,
					master_credentials_secret_arn: provider_outputs?.secret_ref ?? null,
				})),
			project_caches: cacheRows
				.filter((c) => c.project_id === r.id)
				.map(({ project_id: _s, ...c }) => c),
			project_dns:
				r.dns_enabled !== null
					? { domain_name: r.dns_domain_name, enabled: r.dns_enabled }
					: null,
		}));
	});
}
