// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type SQL, sql } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import type {
	ClusterAdmin,
	ClusterProviderConfig,
	DnsProviderConfig,
} from "@/types/database-custom.types";

/**
 * Row shape of the `spec_full` view (lib/db/programmables.sql). OUTPUT column names
 * are cloud-neutral and mirror the table columns (provision_network, cidr_block,
 * cluster_provider_config, …); this interface is the single TS source for them (the SQL
 * is the single source for the view itself). LEFT JOINs to
 * the component tables mean component-derived columns are nullable. Numerics are
 * cast to float8 in the view so they arrive as numbers, not strings.
 *
 * Declared as a `type` (not `interface`) so it carries an implicit index signature
 * and stays assignable to `Record<string, unknown>` — the snapshot is stored into
 * jobs.config_snapshot (JSONB) without a cast.
 */
export type SpecFull = {
	id: string;
	user_id: string;
	zone_id: string | null;
	cloud_identity_id: string | null;
	project_name: string;
	environment_stage: string;
	region: string;
	cloud_provider: string | null;
	cloud_account_id: string | null;
	terraform_version: string;
	status: string;
	estimated_monthly_cost: number | null;
	created_at: string;
	updated_at: string;

	// Network
	provision_network: boolean | null;
	cidr_block: string | null;
	network_id: string | null;
	single_nat_gateway: boolean | null;
	network_status: string | null;

	// Cluster (provider-specific knobs in cluster_provider_config)
	cluster_version: string | null;
	cluster_provider_config: ClusterProviderConfig | null;
	cluster_admins: ClusterAdmin[] | null;
	instance_types: string[] | null;
	node_min_size: number | null;
	node_max_size: number | null;
	node_desired_size: number | null;
	cluster_name: string | null;
	cluster_endpoint: string | null;
	cluster_status: string | null;

	// DNS (provider-specific knobs in dns_provider_config)
	dns_enabled: boolean | null;
	dns_domain_name: string | null;
	dns_zone_id: string | null;
	dns_managed_certificate: boolean | null;
	dns_waf_enabled: boolean | null;
	dns_provider_config: DnsProviderConfig | null;
	dns_status: string | null;

	// Repositories
	apps_destination_repo: string | null;

	// Aggregated
	has_database: boolean;
	db_min_capacity: number | null;
	db_max_capacity: number | null;
	has_cache: boolean;
}

type ServiceDb = ReturnType<typeof getServiceDb>;

/** Filters supported against `spec_full` (all AND-combined, all optional). */
interface SpecFullFilters {
	id?: string;
	user_id?: string;
	project_name?: string;
}

/**
 * Reads rows from the `spec_full` view with the given equality filters. Returns the
 * raw view rows typed as SpecFull[] (caller decides single/array/not-found). Service
 * path only — the 4 consumers are all CLI/runner endpoints on getServiceDb().
 */
export async function querySpecFull(
	db: ServiceDb,
	filters: SpecFullFilters,
): Promise<SpecFull[]> {
	const conds: SQL[] = [];
	if (filters.id !== undefined) conds.push(sql`id = ${filters.id}`);
	if (filters.user_id !== undefined)
		conds.push(sql`user_id = ${filters.user_id}`);
	if (filters.project_name !== undefined)
		conds.push(sql`project_name = ${filters.project_name}`);

	const where = conds.length
		? sql` where ${sql.join(conds, sql` and `)}`
		: sql``;

	return db.execute<SpecFull>(sql`select * from spec_full${where}`);
}
