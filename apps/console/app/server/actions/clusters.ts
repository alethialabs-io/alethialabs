"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, inArray } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import {
	cloudIdentities,
	specCaches,
	specCluster,
	specDatabases,
	specDns,
	specEnvironments,
	specs,
} from "@/lib/db/schema";

export interface ClusterData {
	id: string;
	project_name: string;
	region: string;
	environment_stage: string;
	status: string;
	cloud_identities: { provider: string } | null;
	spec_cluster: {
		cluster_name: string | null;
		cluster_endpoint: string | null;
		cluster_arn: string | null;
		cluster_version: string | null;
		argocd_url: string | null;
		argocd_admin_password: string | null;
		status: string;
	} | null;
	spec_databases: {
		name: string;
		engine: string | null;
		endpoint: string | null;
		reader_endpoint: string | null;
		master_credentials_secret_arn: string | null;
		status: string;
	}[];
	spec_caches: {
		name: string;
		engine: string | null;
		endpoint: string | null;
		status: string;
	}[];
	spec_dns: { domain_name: string | null; enabled: boolean } | null;
}

/** Fetches all active specs with their cluster, database, cache, and DNS data. */
export async function getClusters(): Promise<ClusterData[]> {
	const owner = await getOwner();
	if (!owner) return [];

	return withOwnerScope(owner, async (tx) => {
		// Spec + to-one relations (cloud identity, cluster, dns) in one pass.
		const baseRows = await tx
			.select({
				id: specs.id,
				project_name: specs.project_name,
				region: specs.region,
				// M1: environment + status from the spec's default environment.
				environment_stage: specEnvironments.name,
				status: specEnvironments.status,
				provider: cloudIdentities.provider,
				cluster_name: specCluster.cluster_name,
				cluster_endpoint: specCluster.cluster_endpoint,
				cluster_outputs: specCluster.provider_outputs,
				cluster_version: specCluster.cluster_version,
				argocd_url: specCluster.argocd_url,
				argocd_admin_password: specCluster.argocd_admin_password,
				cluster_status: specCluster.status,
				dns_domain_name: specDns.domain_name,
				dns_enabled: specDns.enabled,
			})
			.from(specs)
			.leftJoin(cloudIdentities, eq(specs.cloud_identity_id, cloudIdentities.id))
			.leftJoin(
				specEnvironments,
				and(
					eq(specEnvironments.spec_id, specs.id),
					eq(specEnvironments.is_default, true),
				),
			)
			.leftJoin(specCluster, eq(specCluster.spec_id, specs.id))
			.leftJoin(specDns, eq(specDns.spec_id, specs.id))
			.where(eq(specEnvironments.status, "ACTIVE"))
			.orderBy(desc(specs.created_at));

		if (baseRows.length === 0) return [];

		const specIds = baseRows.map((r) => r.id);

		// To-many relations fetched in bulk, then grouped by spec.
		const [dbRows, cacheRows] = await Promise.all([
			tx
				.select({
					spec_id: specDatabases.spec_id,
					name: specDatabases.name,
					engine: specDatabases.engine,
					endpoint: specDatabases.endpoint,
					reader_endpoint: specDatabases.reader_endpoint,
					provider_outputs: specDatabases.provider_outputs,
					status: specDatabases.status,
				})
				.from(specDatabases)
				.where(inArray(specDatabases.spec_id, specIds)),
			tx
				.select({
					spec_id: specCaches.spec_id,
					name: specCaches.name,
					engine: specCaches.engine,
					endpoint: specCaches.endpoint,
					status: specCaches.status,
				})
				.from(specCaches)
				.where(inArray(specCaches.spec_id, specIds)),
		]);

		return baseRows.map((r) => ({
			id: r.id,
			project_name: r.project_name,
			region: r.region,
			environment_stage: r.environment_stage ?? "development",
			status: r.status ?? "ACTIVE",
			cloud_identities: r.provider ? { provider: r.provider } : null,
			spec_cluster: r.cluster_status
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
			spec_databases: dbRows
				.filter((d) => d.spec_id === r.id)
				.map(({ spec_id: _s, provider_outputs, ...db }) => ({
					...db,
					master_credentials_secret_arn: provider_outputs?.secret_ref ?? null,
				})),
			spec_caches: cacheRows
				.filter((c) => c.spec_id === r.id)
				.map(({ spec_id: _s, ...c }) => c),
			spec_dns:
				r.dns_enabled !== null
					? { domain_name: r.dns_domain_name, enabled: r.dns_enabled }
					: null,
		}));
	});
}
