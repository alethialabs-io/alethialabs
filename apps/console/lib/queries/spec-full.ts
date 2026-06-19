// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type SQL, sql } from "drizzle-orm";
import type { getServiceDb } from "@/lib/db";
import type { ClusterAdmin } from "@/types/database-custom.types";

/**
 * Row shape of the `spec_full` view (lib/db/programmables.sql). OUTPUT column names
 * match the SpecConfig wire contract (zone_id, create_vpc, …); this interface mirrors
 * those columns and is the single TS source for them (the SQL is the single source for
 * the view itself). LEFT JOINs to
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
	aws_region: string;
	cloud_provider: string | null;
	aws_account_id: string | null;
	terraform_version: string;
	status: string;
	estimated_monthly_cost: number | null;
	created_at: string;
	updated_at: string;

	// Network
	create_vpc: boolean | null;
	vpc_cidr: string | null;
	selected_vpc_id: string | null;
	single_nat_gateway: boolean | null;
	network_status: string | null;
	vpc_status: string | null;

	// Cluster
	cluster_version: string | null;
	enable_karpenter: boolean | null;
	cluster_admins: ClusterAdmin[] | null;
	instance_types: string[] | null;
	node_min_size: number | null;
	node_max_size: number | null;
	node_desired_size: number | null;
	cluster_name: string | null;
	cluster_endpoint: string | null;
	cluster_status: string | null;
	eks_status: string | null;

	// DNS
	enable_dns: boolean | null;
	dns_main_domain: string | null;
	dns_hosted_zone: string | null;
	acm_certificate_enable: boolean | null;
	waf_enabled: boolean | null;
	cloudfront_waf_enabled: boolean | null;
	application_waf_enabled: boolean | null;
	dns_status: string | null;

	// Repositories
	applications_destination_repo: string | null;

	// Aggregated
	create_rds: boolean;
	db_min_capacity: number | null;
	db_max_capacity: number | null;
	enable_redis: boolean;
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
 * path only — the 4 consumers are all CLI/worker endpoints on getServiceDb().
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
