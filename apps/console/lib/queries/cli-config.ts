// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import type {
	CloudProvider,
	ComponentStatus,
	ProjectStatus,
} from "@/lib/db/schema/enums";
import {
	cloudIdentities,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { readEnvComponents } from "@/lib/queries/project-components-read";
import type {
	ClusterAdmin,
	ClusterProviderConfig,
	DnsProviderConfig,
} from "@/types/jsonb.types";

type Executor = Db | Tx;

/**
 * The flat, cloud-neutral config shape the CLI `project get` consumes — the TS successor to the
 * `project_full` SQL view. Assembled from the live component tables via {@link readEnvComponents}
 * instead of a hand-maintained view/type pair, and env-aware (the view was default-env-only). The
 * Go `Configuration` struct (packages/core/types/configuration.go) is a superset of loose pointer
 * fields, so this shape is wire-compatible with existing CLI binaries.
 */
export type CliProjectConfig = {
	id: string;
	user_id: string;
	cloud_identity_id: string | null;
	project_name: string;
	// The env's free-text name (what the view emitted as environment_stage — not the enum).
	environment_stage: string;
	region: string;
	cloud_provider: CloudProvider | null;
	cloud_account_id: string | null;
	iac_version: string;
	status: ProjectStatus;
	estimated_monthly_cost: number | null;
	created_at: string;
	updated_at: string;

	// Network
	provision_network: boolean | null;
	cidr_block: string | null;
	network_id: string | null;
	single_nat_gateway: boolean | null;
	network_status: ComponentStatus | null;

	// Cluster
	cluster_version: string | null;
	cluster_provider_config: ClusterProviderConfig | null;
	cluster_admins: ClusterAdmin[];
	instance_types: string[] | null;
	node_min_size: number | null;
	node_max_size: number | null;
	node_desired_size: number | null;
	cluster_name: string | null;
	cluster_endpoint: string | null;
	cluster_status: ComponentStatus | null;

	// DNS
	dns_enabled: boolean | null;
	dns_domain_name: string | null;
	dns_zone_id: string | null;
	dns_managed_certificate: boolean | null;
	dns_waf_enabled: boolean | null;
	dns_provider_config: DnsProviderConfig | null;
	dns_status: ComponentStatus | null;

	// Repositories
	apps_destination_repo: string | null;
	apps_path: string | null;

	// Aggregated (mirrors the view: scoped to non-DESTROYED components)
	has_database: boolean;
	db_min_capacity: number | null;
	db_max_capacity: number | null;
	has_cache: boolean;
};

type ProjectRow = typeof projects.$inferSelect;
type EnvRow = typeof projectEnvironments.$inferSelect;
type IdentityRow = typeof cloudIdentities.$inferSelect;
type Components = Awaited<ReturnType<typeof readEnvComponents>>;

/** ISO string (or null) — the view emitted timestamps that JSON-serialize to ISO for the CLI. */
function iso(d: Date | null | undefined): string {
	return (d ?? new Date(0)).toISOString();
}

/** Shape the raw rows into the flat CLI config — the exact value set `project_full` produced. */
function toCliConfig(
	project: ProjectRow,
	env: EnvRow,
	identity: IdentityRow | undefined,
	c: Components,
): CliProjectConfig {
	const activeDbs = c.databases.filter((d) => d.status !== "DESTROYED");
	const minCaps = activeDbs
		.map((d) => d.min_capacity)
		.filter((v): v is number => v != null);
	const maxCaps = activeDbs
		.map((d) => d.max_capacity)
		.filter((v): v is number => v != null);
	return {
		id: project.id,
		user_id: project.user_id,
		cloud_identity_id: project.cloud_identity_id,
		project_name: project.project_name,
		// The view emitted the env's NAME as environment_stage (env identity, not the enum).
		environment_stage: env.name,
		region: project.region,
		cloud_provider: identity?.provider ?? null,
		cloud_account_id: identity?.credentials?.account_id ?? null,
		iac_version: project.iac_version,
		status: env.status,
		estimated_monthly_cost: project.estimated_monthly_cost,
		created_at: iso(project.created_at),
		updated_at: iso(project.updated_at),

		provision_network: c.network?.provision_network ?? null,
		cidr_block: c.network?.cidr_block ?? null,
		network_id: c.network?.network_id ?? null,
		single_nat_gateway: c.network?.single_nat_gateway ?? null,
		network_status: c.network?.status ?? null,

		cluster_version: c.cluster?.cluster_version ?? null,
		cluster_provider_config: c.cluster?.provider_config ?? null,
		// The view COALESCEs to [] (never null), sourcing from the cluster_admins child table.
		cluster_admins: c.clusterAdmins,
		instance_types: c.cluster?.instance_types ?? null,
		node_min_size: c.cluster?.node_min_size ?? null,
		node_max_size: c.cluster?.node_max_size ?? null,
		node_desired_size: c.cluster?.node_desired_size ?? null,
		cluster_name: c.cluster?.cluster_name ?? null,
		cluster_endpoint: c.cluster?.cluster_endpoint ?? null,
		cluster_status: c.cluster?.status ?? null,

		dns_enabled: c.dns?.enabled ?? null,
		dns_domain_name: c.dns?.domain_name ?? null,
		dns_zone_id: c.dns?.zone_id ?? null,
		dns_managed_certificate: c.dns?.managed_certificate ?? null,
		dns_waf_enabled: c.dns?.waf_enabled ?? null,
		dns_provider_config: c.dns?.provider_config ?? null,
		dns_status: c.dns?.status ?? null,

		apps_destination_repo: c.repositories?.apps_destination_repo ?? null,
		apps_path: c.repositories?.apps_path ?? null,

		has_database: activeDbs.length > 0,
		db_min_capacity: minCaps.length ? Math.min(...minCaps) : null,
		db_max_capacity: maxCaps.length ? Math.max(...maxCaps) : null,
		has_cache: c.caches.some((ca) => ca.status !== "DESTROYED"),
	};
}

/**
 * Resolves one CLI user's project config by name — the TS replacement for
 * `queryProjectFull({ user_id, project_name })`. Env-aware: `envId` selects a specific environment;
 * absent, it falls back to the project's default env (the view's hardcoded behaviour). Returns null
 * when the project (or requested env) isn't found. Service path (getServiceDb), scoped by user_id.
 */
export async function getCliConfig(
	db: Executor,
	opts: { userId: string; projectName: string; envId?: string },
): Promise<CliProjectConfig | null> {
	const [project] = await db
		.select()
		.from(projects)
		.where(
			and(
				eq(projects.user_id, opts.userId),
				eq(projects.project_name, opts.projectName),
			),
		)
		.limit(1);
	if (!project) return null;

	const envs = await db
		.select()
		.from(projectEnvironments)
		.where(eq(projectEnvironments.project_id, project.id));
	const env = opts.envId
		? envs.find((e) => e.id === opts.envId)
		: (envs.find((e) => e.is_default) ?? envs[0]);
	if (!env) return null;

	const identity = project.cloud_identity_id
		? (
				await db
					.select()
					.from(cloudIdentities)
					.where(eq(cloudIdentities.id, project.cloud_identity_id))
					.limit(1)
			)[0]
		: undefined;

	const components = await readEnvComponents(db, project.id, env.id, {
		cluster: "env",
	});
	return toCliConfig(project, env, identity, components);
}
