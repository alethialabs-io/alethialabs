"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
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
	convertVineConfig,
} from "@/lib/cloud-providers";
import { notifyScaler } from "@/lib/scaler";
import type { VineFormData } from "@/lib/validations/vine-form.schema";
import { eq } from "drizzle-orm";

// ============================================================
// Types — form-facing shapes (vineyard_id retained until the form layer is
// renamed; mapped to zone_id / spec_id at the DB boundary below).
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

export interface CreateVineInput {
	vine: {
		project_name: string;
		environment_stage: Spec["environment_stage"];
		region: string;
		cloud_identity_id?: string | null;
		terraform_version: string;
		vineyard_id?: string | null;
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

export async function createVine(data: CreateVineInput) {
	const owner = await requireOwner();

	return withOwnerScope(owner, async (tx) => {
		const { vineyard_id, ...vineFields } = data.vine;

		const [vine] = await tx
			.insert(specs)
			.values({ ...vineFields, zone_id: vineyard_id ?? null, user_id: owner })
			.returning();

		if (!vine) throw new Error("Failed to create spec");

		// Singleton components (tx rolls back automatically on any failure).
		await tx.insert(specNetwork).values({ spec_id: vine.id, ...data.network });
		await tx.insert(specCluster).values({ spec_id: vine.id, ...data.cluster });
		await tx.insert(specDns).values({ spec_id: vine.id, ...data.dns });
		await tx
			.insert(specRepositories)
			.values({ spec_id: vine.id, ...data.repositories });

		if (data.databases?.length) {
			await tx
				.insert(specDatabases)
				.values(data.databases.map((db) => ({ spec_id: vine.id, ...db })));
		}
		if (data.caches?.length) {
			await tx
				.insert(specCaches)
				.values(data.caches.map((c) => ({ spec_id: vine.id, ...c })));
		}
		if (data.queues?.length) {
			await tx
				.insert(specQueues)
				.values(data.queues.map((q) => ({ spec_id: vine.id, ...q })));
		}
		if (data.topics?.length) {
			await tx
				.insert(specTopics)
				.values(data.topics.map((t) => ({ spec_id: vine.id, ...t })));
		}

		await tx.insert(auditLog).values({
			spec_id: vine.id,
			user_id: owner,
			action: "CREATED",
			changes: {
				project_name: data.vine.project_name,
				environment: data.vine.environment_stage,
			},
		});

		return { vine };
	});
}

// ============================================================
// Read
// ============================================================

export async function getVines() {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const vines = await tx
			.select()
			.from(specs)
			.orderBy(specs.created_at);
		return { vines };
	});
}

export async function getVine(vineId: string) {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [vine] = await tx
			.select()
			.from(specs)
			.where(eq(specs.id, vineId))
			.limit(1);
		if (!vine) throw new Error("Vine not found");

		const [network] = await tx
			.select()
			.from(specNetwork)
			.where(eq(specNetwork.spec_id, vineId))
			.limit(1);
		const [cluster] = await tx
			.select()
			.from(specCluster)
			.where(eq(specCluster.spec_id, vineId))
			.limit(1);
		const [dns] = await tx
			.select()
			.from(specDns)
			.where(eq(specDns.spec_id, vineId))
			.limit(1);
		const [repos] = await tx
			.select()
			.from(specRepositories)
			.where(eq(specRepositories.spec_id, vineId))
			.limit(1);
		const databases = await tx
			.select()
			.from(specDatabases)
			.where(eq(specDatabases.spec_id, vineId));
		const caches = await tx
			.select()
			.from(specCaches)
			.where(eq(specCaches.spec_id, vineId));
		const queues = await tx
			.select()
			.from(specQueues)
			.where(eq(specQueues.spec_id, vineId));
		const topics = await tx
			.select()
			.from(specTopics)
			.where(eq(specTopics.spec_id, vineId));
		const nosqlTables = await tx
			.select()
			.from(specNosqlTables)
			.where(eq(specNosqlTables.spec_id, vineId));
		const secrets = await tx
			.select()
			.from(specSecrets)
			.where(eq(specSecrets.spec_id, vineId));

		let cloudProvider = "aws";
		if (vine.cloud_identity_id) {
			const [ci] = await tx
				.select({ provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, vine.cloud_identity_id))
				.limit(1);
			if (ci) cloudProvider = ci.provider;
		}

		return {
			vine,
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

async function buildConfigSnapshot(owner: string, vineId: string) {
	return withOwnerScope(owner, async (tx) => {
		const [vine] = await tx
			.select()
			.from(specs)
			.where(eq(specs.id, vineId))
			.limit(1);
		if (!vine) throw new Error("Vine not found");

		if (!vine.cloud_identity_id) {
			throw new Error(
				"No cloud account linked to this spec. Go to Connectors to connect.",
			);
		}

		const [identity] = await tx
			.select({ id: cloudIdentities.id, provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, vine.cloud_identity_id))
			.limit(1);

		if (!identity) {
			throw new Error(
				"Cloud account is not verified. Go to Connectors to verify.",
			);
		}

		const [network] = await tx
			.select()
			.from(specNetwork)
			.where(eq(specNetwork.spec_id, vineId))
			.limit(1);
		const [cluster] = await tx
			.select()
			.from(specCluster)
			.where(eq(specCluster.spec_id, vineId))
			.limit(1);
		const [dns] = await tx
			.select()
			.from(specDns)
			.where(eq(specDns.spec_id, vineId))
			.limit(1);
		const [repos] = await tx
			.select()
			.from(specRepositories)
			.where(eq(specRepositories.spec_id, vineId))
			.limit(1);
		const databases = await tx
			.select()
			.from(specDatabases)
			.where(eq(specDatabases.spec_id, vineId));
		const caches = await tx
			.select()
			.from(specCaches)
			.where(eq(specCaches.spec_id, vineId));
		const queues = await tx
			.select()
			.from(specQueues)
			.where(eq(specQueues.spec_id, vineId));
		const topics = await tx
			.select()
			.from(specTopics)
			.where(eq(specTopics.spec_id, vineId));
		const nosqlTables = await tx
			.select()
			.from(specNosqlTables)
			.where(eq(specNosqlTables.spec_id, vineId));
		const secrets = await tx
			.select()
			.from(specSecrets)
			.where(eq(specSecrets.spec_id, vineId));

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
			...vine,
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
			// Token is fetched at runtime by the worker via POST /api/jobs/[id]/git-token.
			git_access_token: "",
		};

		return { vine, identity, configSnapshot };
	});
}

export async function planVine(vineId: string, workerId?: string | null) {
	const owner = await requireOwner();
	const { vine, identity, configSnapshot } = await buildConfigSnapshot(
		owner,
		vineId,
	);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				spec_id: vineId,
				zone_id: vine.zone_id ?? null,
				cloud_identity_id: identity.id,
				job_type: "PLAN",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(workerId ? { assigned_runner_id: workerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx.update(specs).set({ status: "QUEUED" }).where(eq(specs.id, vineId));
		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

export async function provisionVine(
	vineId: string,
	planJobId?: string,
	workerId?: string | null,
) {
	const owner = await requireOwner();
	const { vine, identity, configSnapshot } = await buildConfigSnapshot(
		owner,
		vineId,
	);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				spec_id: vineId,
				zone_id: vine.zone_id ?? null,
				cloud_identity_id: identity.id,
				job_type: "DEPLOY",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(planJobId ? { plan_job_id: planJobId } : {}),
				...(workerId ? { assigned_runner_id: workerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx.update(specs).set({ status: "QUEUED" }).where(eq(specs.id, vineId));

		await tx.insert(auditLog).values({
			spec_id: vineId,
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

export async function deleteVine(vineId: string) {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		// CASCADE handles all component tables.
		await tx.delete(specs).where(eq(specs.id, vineId));
		return { success: true };
	});
}

// ============================================================
// Duplicate for another provider
// ============================================================

/** Converts a spec's DB representation to VineFormData for duplication / pre-populating forms. */
export async function getVineAsFormData(
	vineId: string,
): Promise<{ formData: VineFormData; provider: CloudProviderSlug }> {
	const source = await getVine(vineId);

	let provider: CloudProviderSlug = "aws";
	if (source.vine.cloud_identity_id) {
		const owner = await requireOwner();
		const ci = await withOwnerScope(owner, async (tx) => {
			const [row] = await tx
				.select({ provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, source.vine.cloud_identity_id!))
				.limit(1);
			return row;
		});
		if (!ci) throw new Error("Cloud identity not found");
		provider = ci.provider as CloudProviderSlug;
	}

	const formData: VineFormData = {
		vine: {
			project_name: source.vine.project_name,
			environment_stage: source.vine.environment_stage,
			region: source.vine.region,
			cloud_identity_id: source.vine.cloud_identity_id ?? "",
			terraform_version: source.vine.terraform_version,
			vineyard_id: source.vine.zone_id ?? "",
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
			fifo: q.fifo ?? undefined,
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
			hash_key: t.hash_key,
			hash_key_type: t.hash_key_type ?? undefined,
			range_key: t.range_key ?? undefined,
			range_key_type: t.range_key_type ?? undefined,
			table_type: t.table_type ?? undefined,
			billing_mode: t.billing_mode ?? undefined,
			point_in_time_recovery: t.point_in_time_recovery ?? undefined,
		})),
		secrets: source.components.secrets.map((s) => ({
			name: s.name,
			generate: s.generate ?? undefined,
			length: s.length ?? undefined,
			special_chars: s.special_chars ?? undefined,
		})),
	} as VineFormData;

	return { formData, provider };
}

/** Duplicates a spec config for a different cloud provider, mapping provider-specific values. */
export async function duplicateVineForProvider(
	sourceVineId: string,
	targetCloudIdentityId: string,
	targetRegion: string,
): Promise<{
	newVineId: string;
	vineyardId: string;
	warnings: ConversionWarning[];
}> {
	const owner = await requireOwner();

	const { formData, provider: sourceProvider } =
		await getVineAsFormData(sourceVineId);

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

	const { data: converted, warnings } = convertVineConfig(
		formData,
		sourceProvider,
		targetProvider,
	);

	converted.vine.region = targetRegion;
	converted.vine.cloud_identity_id = targetCloudIdentityId;

	const input = converted as unknown as CreateVineInput;
	const { vine } = await createVine(input);

	return {
		newVineId: vine.id,
		vineyardId: converted.vine.vineyard_id,
		warnings,
	};
}
