"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { withOwnerScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	resourceHierarchy,
	type Spec,
	specCaches,
	specCluster,
	specDatabases,
	specDns,
	specNetwork,
	specNosqlTables,
	specQueues,
	specRepositories,
	specSecrets,
	specTopics,
	specs,
} from "@/lib/db/schema";
import {
	type CloudProviderSlug,
	type ConversionWarning,
	convertSpecConfig,
} from "@/lib/cloud-providers";
import { notifyScaler } from "@/lib/scaler";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";
import { eq } from "drizzle-orm";

// ============================================================
// Types — form-facing shapes mapped to the spec/zone DB columns below.
// ============================================================

type ComponentInsert<T> = Omit<
	T,
	| "id"
	| "spec_id"
	| "status"
	| "status_message"
	| "estimated_monthly_cost"
	| "created_at"
	| "updated_at"
>;

export interface CreateSpecInput {
	spec: {
		project_name: string;
		environment_stage: Spec["environment_stage"];
		region: string;
		cloud_identity_id?: string | null;
		terraform_version: string;
		zone_id?: string | null;
	};
	network: ComponentInsert<typeof specNetwork.$inferInsert>;
	cluster: Omit<
		ComponentInsert<typeof specCluster.$inferInsert>,
		"cluster_name" | "cluster_endpoint"
	>;
	dns: ComponentInsert<typeof specDns.$inferInsert>;
	repositories: Omit<
		typeof specRepositories.$inferInsert,
		"id" | "spec_id" | "created_at" | "updated_at"
	>;
	databases?: Omit<
		ComponentInsert<typeof specDatabases.$inferInsert>,
		"endpoint" | "reader_endpoint"
	>[];
	caches?: Omit<
		ComponentInsert<typeof specCaches.$inferInsert>,
		"endpoint"
	>[];
	queues?: ComponentInsert<typeof specQueues.$inferInsert>[];
	topics?: ComponentInsert<typeof specTopics.$inferInsert>[];
}

// ============================================================
// Create
// ============================================================

export async function createSpec(data: CreateSpecInput) {
	const actor = await authorize("create", { type: "spec" });
	const owner = actor.userId;

	return withOwnerScope(owner, async (tx) => {
		const { zone_id, ...specFields } = data.spec;

		const [spec] = await tx
			.insert(specs)
			.values({ ...specFields, zone_id: zone_id ?? null, user_id: owner })
			.returning();

		if (!spec) throw new Error("Failed to create spec");

		// Authz hierarchy edge: spec → its zone (or → org when zone-less), so a
		// higher-scope grant flows down to this spec.
		await tx
			.insert(resourceHierarchy)
			.values(
				zone_id
					? {
							child_type: "spec",
							child_id: spec.id,
							parent_type: "zone",
							parent_id: zone_id,
						}
					: {
							child_type: "spec",
							child_id: spec.id,
							parent_type: "org",
							parent_id: owner,
						},
			)
			.onConflictDoNothing();

		// Singleton components (tx rolls back automatically on any failure).
		await tx.insert(specNetwork).values({ spec_id: spec.id, ...data.network });
		await tx.insert(specCluster).values({ spec_id: spec.id, ...data.cluster });
		await tx.insert(specDns).values({ spec_id: spec.id, ...data.dns });
		await tx
			.insert(specRepositories)
			.values({ spec_id: spec.id, ...data.repositories });

		if (data.databases?.length) {
			await tx
				.insert(specDatabases)
				.values(data.databases.map((db) => ({ spec_id: spec.id, ...db })));
		}
		if (data.caches?.length) {
			await tx
				.insert(specCaches)
				.values(data.caches.map((c) => ({ spec_id: spec.id, ...c })));
		}
		if (data.queues?.length) {
			await tx
				.insert(specQueues)
				.values(data.queues.map((q) => ({ spec_id: spec.id, ...q })));
		}
		if (data.topics?.length) {
			await tx
				.insert(specTopics)
				.values(data.topics.map((t) => ({ spec_id: spec.id, ...t })));
		}

		await tx.insert(auditLog).values({
			spec_id: spec.id,
			user_id: owner,
			action: "CREATED",
			changes: {
				project_name: data.spec.project_name,
				environment: data.spec.environment_stage,
			},
		});

		return { spec };
	});
}

// ============================================================
// Read
// ============================================================

export async function getSpecs() {
	const actor = await authorize("view", { type: "spec" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const specList = await tx
			.select()
			.from(specs)
			.orderBy(specs.created_at);
		return { specs: specList };
	});
}

export async function getSpec(specId: string) {
	const actor = await authorize("view", { type: "spec", id: specId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [spec] = await tx
			.select()
			.from(specs)
			.where(eq(specs.id, specId))
			.limit(1);
		if (!spec) throw new Error("Spec not found");

		const [network] = await tx
			.select()
			.from(specNetwork)
			.where(eq(specNetwork.spec_id, specId))
			.limit(1);
		const [cluster] = await tx
			.select()
			.from(specCluster)
			.where(eq(specCluster.spec_id, specId))
			.limit(1);
		const [dns] = await tx
			.select()
			.from(specDns)
			.where(eq(specDns.spec_id, specId))
			.limit(1);
		const [repos] = await tx
			.select()
			.from(specRepositories)
			.where(eq(specRepositories.spec_id, specId))
			.limit(1);
		const databases = await tx
			.select()
			.from(specDatabases)
			.where(eq(specDatabases.spec_id, specId));
		const caches = await tx
			.select()
			.from(specCaches)
			.where(eq(specCaches.spec_id, specId));
		const queues = await tx
			.select()
			.from(specQueues)
			.where(eq(specQueues.spec_id, specId));
		const topics = await tx
			.select()
			.from(specTopics)
			.where(eq(specTopics.spec_id, specId));
		const nosqlTables = await tx
			.select()
			.from(specNosqlTables)
			.where(eq(specNosqlTables.spec_id, specId));
		const secrets = await tx
			.select()
			.from(specSecrets)
			.where(eq(specSecrets.spec_id, specId));

		let cloudProvider = "aws";
		if (spec.cloud_identity_id) {
			const [ci] = await tx
				.select({ provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, spec.cloud_identity_id))
				.limit(1);
			if (ci) cloudProvider = ci.provider;
		}

		return {
			spec,
			cloudProvider,
			components: {
				network: network ?? null,
				cluster: cluster ?? null,
				dns: dns ?? null,
				repositories: repos ?? null,
				databases,
				caches,
				queues,
				topics,
				nosql_tables: nosqlTables,
				secrets,
			},
		};
	});
}

// ============================================================
// Provision
// ============================================================

async function buildConfigSnapshot(owner: string, specId: string) {
	return withOwnerScope(owner, async (tx) => {
		const [spec] = await tx
			.select()
			.from(specs)
			.where(eq(specs.id, specId))
			.limit(1);
		if (!spec) throw new Error("Spec not found");

		if (!spec.cloud_identity_id) {
			throw new Error(
				"No cloud account linked to this spec. Go to Connectors to connect.",
			);
		}

		const [identity] = await tx
			.select({ id: cloudIdentities.id, provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, spec.cloud_identity_id))
			.limit(1);

		if (!identity) {
			throw new Error(
				"Cloud account is not verified. Go to Connectors to verify.",
			);
		}

		const [network] = await tx
			.select()
			.from(specNetwork)
			.where(eq(specNetwork.spec_id, specId))
			.limit(1);
		const [cluster] = await tx
			.select()
			.from(specCluster)
			.where(eq(specCluster.spec_id, specId))
			.limit(1);
		const [dns] = await tx
			.select()
			.from(specDns)
			.where(eq(specDns.spec_id, specId))
			.limit(1);
		const [repos] = await tx
			.select()
			.from(specRepositories)
			.where(eq(specRepositories.spec_id, specId))
			.limit(1);
		const databases = await tx
			.select()
			.from(specDatabases)
			.where(eq(specDatabases.spec_id, specId));
		const caches = await tx
			.select()
			.from(specCaches)
			.where(eq(specCaches.spec_id, specId));
		const queues = await tx
			.select()
			.from(specQueues)
			.where(eq(specQueues.spec_id, specId));
		const topics = await tx
			.select()
			.from(specTopics)
			.where(eq(specTopics.spec_id, specId));
		const nosqlTables = await tx
			.select()
			.from(specNosqlTables)
			.where(eq(specNosqlTables.spec_id, specId));
		const secrets = await tx
			.select()
			.from(specSecrets)
			.where(eq(specSecrets.spec_id, specId));

		if (network?.provision_network === false && !network?.network_id) {
			const netLabel =
				identity.provider === "azure"
					? "VNet"
					: identity.provider === "gcp"
						? "network"
						: "VPC";
			throw new Error(
				`Cannot plan: no ${netLabel} selected. Edit the spec's network settings or enable network provisioning.`,
			);
		}

		const configSnapshot = {
			...spec,
			provider: identity.provider,
			network: {
				provision_network: network?.provision_network ?? true,
				cidr_block: network?.cidr_block ?? "10.0.0.0/16",
				network_id: network?.network_id,
				single_nat_gateway: network?.single_nat_gateway ?? true,
			},
			cluster: {
				cluster_version: cluster?.cluster_version,
				instance_types: cluster?.instance_types ?? [],
				node_min_size: cluster?.node_min_size ?? 2,
				node_max_size: cluster?.node_max_size ?? 5,
				node_desired_size: cluster?.node_desired_size ?? 2,
				cluster_admins: cluster?.cluster_admins ?? [],
				provider_config: cluster?.provider_config ?? {},
			},
			dns: {
				enabled: dns?.enabled ?? false,
				zone_id: dns?.zone_id,
				domain_name: dns?.domain_name,
				provider_config: dns?.provider_config ?? {},
			},
			repositories: {
				apps_destination_repo: repos?.apps_destination_repo,
			},
			databases,
			caches,
			queues,
			topics,
			nosql_tables: nosqlTables,
			secrets,
			// Token is fetched at runtime by the runner via POST /api/jobs/[id]/git-token.
			git_access_token: "",
		};

		return { spec, identity, configSnapshot };
	});
}

export async function planSpec(specId: string, runnerId?: string | null) {
	const actor = await authorize("plan", { type: "spec", id: specId });
	const owner = actor.userId;
	const { spec, identity, configSnapshot } = await buildConfigSnapshot(
		owner,
		specId,
	);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				spec_id: specId,
				zone_id: spec.zone_id ?? null,
				cloud_identity_id: identity.id,
				job_type: "PLAN",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(runnerId ? { assigned_runner_id: runnerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx.update(specs).set({ status: "QUEUED" }).where(eq(specs.id, specId));
		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

export async function provisionSpec(
	specId: string,
	planJobId?: string,
	runnerId?: string | null,
) {
	const actor = await authorize("deploy", { type: "spec", id: specId });
	const owner = actor.userId;
	const { spec, identity, configSnapshot } = await buildConfigSnapshot(
		owner,
		specId,
	);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				spec_id: specId,
				zone_id: spec.zone_id ?? null,
				cloud_identity_id: identity.id,
				job_type: "DEPLOY",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(planJobId ? { plan_job_id: planJobId } : {}),
				...(runnerId ? { assigned_runner_id: runnerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx.update(specs).set({ status: "QUEUED" }).where(eq(specs.id, specId));

		await tx.insert(auditLog).values({
			spec_id: specId,
			user_id: owner,
			action: "PROVISIONED",
			changes: { job_id: job.id },
		});

		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

// ============================================================
// Delete
// ============================================================

export async function deleteSpec(specId: string) {
	const actor = await authorize("destroy", { type: "spec", id: specId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		// CASCADE handles all component tables.
		await tx.delete(specs).where(eq(specs.id, specId));
		return { success: true };
	});
}

// ============================================================
// Duplicate for another provider
// ============================================================

/** Converts a spec's DB representation to SpecFormData for duplication / pre-populating forms. */
export async function getSpecAsFormData(
	specId: string,
): Promise<{ formData: SpecFormData; provider: CloudProviderSlug }> {
	const source = await getSpec(specId);

	let provider: CloudProviderSlug = "aws";
	if (source.spec.cloud_identity_id) {
		const owner = await requireOwner();
		const ci = await withOwnerScope(owner, async (tx) => {
			const [row] = await tx
				.select({ provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, source.spec.cloud_identity_id!))
				.limit(1);
			return row;
		});
		if (!ci) throw new Error("Cloud identity not found");
		provider = ci.provider as CloudProviderSlug;
	}

	const formData: SpecFormData = {
		spec: {
			project_name: source.spec.project_name,
			environment_stage: source.spec.environment_stage,
			region: source.spec.region,
			cloud_identity_id: source.spec.cloud_identity_id ?? "",
			terraform_version: source.spec.terraform_version,
			zone_id: source.spec.zone_id ?? "",
		},
		network: source.components.network
			? {
					provision_network: source.components.network.provision_network,
					cidr_block: source.components.network.cidr_block ?? "10.0.0.0/16",
					single_nat_gateway:
						source.components.network.single_nat_gateway ?? true,
					network_id: source.components.network.network_id ?? undefined,
				}
			: {
					provision_network: true,
					cidr_block: "10.0.0.0/16",
					single_nat_gateway: true,
				},
		cluster: source.components.cluster
			? {
					cluster_version: source.components.cluster.cluster_version ?? "1.31",
					instance_types: source.components.cluster.instance_types ?? [],
					node_min_size: source.components.cluster.node_min_size ?? 2,
					node_max_size: source.components.cluster.node_max_size ?? 5,
					node_desired_size: source.components.cluster.node_desired_size ?? 2,
					cluster_admins: source.components.cluster.cluster_admins ?? [],
					provider_config: source.components.cluster.provider_config ?? {},
				}
			: {
					cluster_version: "1.31",
					instance_types: [],
					node_min_size: 2,
					node_max_size: 5,
					node_desired_size: 2,
					cluster_admins: [],
					provider_config: {},
				},
		dns: source.components.dns
			? {
					enabled: source.components.dns.enabled,
					zone_id: source.components.dns.zone_id ?? undefined,
					domain_name: source.components.dns.domain_name ?? undefined,
					managed_certificate:
						source.components.dns.managed_certificate ?? false,
					waf_enabled: source.components.dns.waf_enabled ?? false,
					provider_config: source.components.dns.provider_config ?? {},
				}
			: { enabled: false },
		repositories: source.components.repositories
			? {
					apps_destination_repo:
						source.components.repositories.apps_destination_repo ?? undefined,
				}
			: {},
		databases: source.components.databases.map((db) => ({
			name: db.name,
			engine: db.engine ?? undefined,
			engine_version: db.engine_version ?? undefined,
			min_capacity: db.min_capacity ?? undefined,
			max_capacity: db.max_capacity ?? undefined,
			port: db.port ?? undefined,
			backup_retention_days: db.backup_retention_days ?? undefined,
			iam_auth: db.iam_auth ?? undefined,
		})),
		caches: source.components.caches.map((c) => ({
			name: c.name,
			engine: c.engine ?? undefined,
			node_type: c.node_type ?? undefined,
			num_cache_nodes: c.num_cache_nodes ?? undefined,
			multi_az: c.multi_az ?? undefined,
		})),
		queues: source.components.queues.map((q) => ({
			name: q.name,
			ordered: q.ordered ?? undefined,
			visibility_timeout: q.visibility_timeout ?? undefined,
			message_retention: q.message_retention ?? undefined,
			delay_seconds: q.delay_seconds ?? undefined,
		})),
		topics: source.components.topics.map((t) => ({
			name: t.name,
			subscriptions: t.subscriptions ?? undefined,
		})),
		nosql_tables: source.components.nosql_tables.map((t) => ({
			name: t.name,
			partition_key: t.partition_key,
			partition_key_type: t.partition_key_type ?? undefined,
			sort_key: t.sort_key ?? undefined,
			sort_key_type: t.sort_key_type ?? undefined,
			table_type: t.table_type ?? undefined,
			capacity_mode: t.capacity_mode ?? undefined,
			point_in_time_recovery: t.point_in_time_recovery ?? undefined,
		})),
		secrets: source.components.secrets.map((s) => ({
			name: s.name,
			generate: s.generate ?? undefined,
			length: s.length ?? undefined,
			special_chars: s.special_chars ?? undefined,
		})),
	} as SpecFormData;

	return { formData, provider };
}

/** Duplicates a spec config for a different cloud provider, mapping provider-specific values. */
export async function duplicateSpecForProvider(
	sourceSpecId: string,
	targetCloudIdentityId: string,
	targetRegion: string,
): Promise<{
	newSpecId: string;
	zoneId: string;
	warnings: ConversionWarning[];
}> {
	const actor = await authorize("create", { type: "spec" });
	const owner = actor.userId;

	const { formData, provider: sourceProvider } =
		await getSpecAsFormData(sourceSpecId);

	const targetIdentity = await withOwnerScope(owner, async (tx) => {
		const [row] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, targetCloudIdentityId))
			.limit(1);
		return row;
	});

	if (!targetIdentity) throw new Error("Target cloud identity not found");

	const targetProvider = targetIdentity.provider as CloudProviderSlug;

	const { data: converted, warnings } = convertSpecConfig(
		formData,
		sourceProvider,
		targetProvider,
	);

	converted.spec.region = targetRegion;
	converted.spec.cloud_identity_id = targetCloudIdentityId;

	const input = converted as unknown as CreateSpecInput;
	const { spec } = await createSpec(input);

	return {
		newSpecId: spec.id,
		zoneId: converted.spec.zone_id,
		warnings,
	};
}
