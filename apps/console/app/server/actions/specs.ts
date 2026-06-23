"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import { withOwnerScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	type EnvironmentStage,
	jobs,
	resourceHierarchy,
	type Spec,
	type SpecEnvironment,
	specCaches,
	specCluster,
	specContainerRegistries,
	specDatabases,
	specDns,
	specEnvironments,
	specNetwork,
	specNosqlTables,
	specObservability,
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
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { notifyScaler } from "@/lib/scaler";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";
import { pickFreeSlug, slugify } from "@/lib/routing";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

/**
 * Mirrors the Go provisioner gate (packages/core/provisioner/placement.go):
 * a CORE resource placed on a cloud account other than the spec's primary one is
 * a hot cross-cloud data-plane edge we can't provision yet. Thrown before a job is
 * queued so the user fails fast.
 */
function placementGateError(resourceType: string, name: string): Error {
	return new Error(
		`Cross-cloud ${resourceType} "${name}" targets a different cloud account than this stack's core. ` +
			"Hot cross-cloud data-plane edges (compute reaching a primary datastore in another cloud) are on " +
			"the roadmap and require cross-cloud networking that isn't available yet — move this resource onto " +
			"the stack's primary cloud, or model it as an independent per-cloud stack.",
	);
}

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
		// M1: the spec's INITIAL environment — createSpec turns this into the spec's
		// default `spec_environments` row (name + stage), not a column on `specs`.
		environment_stage: EnvironmentStage;
		region: string;
		cloud_identity_id?: string | null;
		iac_version: string;
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
	nosql_tables?: ComponentInsert<typeof specNosqlTables.$inferInsert>[];
	secrets?: ComponentInsert<typeof specSecrets.$inferInsert>[];
}

// ============================================================
// Create
// ============================================================

export async function createSpec(data: CreateSpecInput) {
	const actor = await authorize("create", { type: "spec" });
	const owner = actor.userId;

	return withOwnerScope(owner, async (tx) => {
		// M1: environment_stage is no longer a spec column — it seeds the default env.
		const { zone_id, environment_stage, ...specFields } = data.spec;

		// C2: derive a unique-per-zone URL slug from the project name.
		const zoneScope = zone_id ?? null;
		const existing = await tx
			.select({ slug: specs.slug })
			.from(specs)
			.where(
				zoneScope === null
					? isNull(specs.zone_id)
					: eq(specs.zone_id, zoneScope),
			);
		const slug = pickFreeSlug(
			slugify(specFields.project_name) || "spec",
			existing.map((r) => r.slug),
		);

		const [spec] = await tx
			.insert(specs)
			.values({ ...specFields, slug, zone_id: zone_id ?? null, user_id: owner })
			.returning();

		if (!spec) throw new Error("Failed to create spec");

		// The spec's default (and, for now, only) environment. `name` = the chosen
		// stage value so the tofu/S3 state path matches the legacy single-env path.
		await tx.insert(specEnvironments).values({
			spec_id: spec.id,
			user_id: owner,
			org_id: spec.org_id,
			name: environment_stage,
			stage: environment_stage,
			status: "DRAFT",
			is_default: true,
			region: specFields.region,
		});

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
		mirrorHierarchyEdge(
			"spec",
			spec.id,
			zone_id ? "zone" : "org",
			zone_id ?? owner,
		);

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
		if (data.nosql_tables?.length) {
			await tx
				.insert(specNosqlTables)
				.values(data.nosql_tables.map((n) => ({ spec_id: spec.id, ...n })));
		}
		if (data.secrets?.length) {
			await tx
				.insert(specSecrets)
				.values(data.secrets.map((s) => ({ spec_id: spec.id, ...s })));
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
		// M1: surface each spec's default-environment name + status (the columns moved
		// off `specs` into spec_environments) so list consumers keep reading them.
		const rows = await tx
			.select({
				spec: specs,
				env_name: specEnvironments.name,
				env_status: specEnvironments.status,
			})
			.from(specs)
			.leftJoin(
				specEnvironments,
				and(
					eq(specEnvironments.spec_id, specs.id),
					eq(specEnvironments.is_default, true),
				),
			)
			.orderBy(specs.created_at);
		const specList = rows.map((r) => ({
			...r.spec,
			environment_stage: r.env_name ?? "development",
			status: r.env_status ?? "DRAFT",
		}));
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

		// M1: the spec's environments (default first). The default env's name + status
		// surface as `spec.environment_stage` / `spec.status` so existing single-value
		// reads keep working; the full list drives the Environments management UI.
		const environments = await tx
			.select()
			.from(specEnvironments)
			.where(eq(specEnvironments.spec_id, specId))
			.orderBy(desc(specEnvironments.is_default), specEnvironments.created_at);
		const defaultEnv =
			environments.find((e) => e.is_default) ?? environments[0] ?? null;

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
			spec: {
				...spec,
				environment_stage: defaultEnv?.name ?? "development",
				status: defaultEnv?.status ?? "DRAFT",
				default_environment_id: defaultEnv?.id ?? null,
			},
			environments,
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

async function buildConfigSnapshot(
	owner: string,
	specId: string,
	environmentId?: string | null,
) {
	return withOwnerScope(owner, async (tx) => {
		const [spec] = await tx
			.select()
			.from(specs)
			.where(eq(specs.id, specId))
			.limit(1);
		if (!spec) throw new Error("Spec not found");

		// M1: resolve which environment this job provisions (the given one, else the
		// spec's default). Its `name` feeds the frozen snapshot `environment_stage`
		// key → the Go provisioner's tofu/S3 state path, unchanged.
		const environment = await resolveTargetEnvironment(tx, specId, environmentId);

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
		const containerRegistries = await tx
			.select()
			.from(specContainerRegistries)
			.where(eq(specContainerRegistries.spec_id, specId));
		const [observability] = await tx
			.select()
			.from(specObservability)
			.where(eq(specObservability.spec_id, specId))
			.limit(1);

		// ── Resolve per-resource placement ("versatile model") ───────────────
		// Each component may carry its own cloud_identity_id/region; NULL inherits
		// the spec's primary identity. Resolve every component to a concrete
		// placement and enforce the provisioning gate (mirrors the Go
		// ValidatePlacement): CORE resources must colocate on the primary cloud;
		// PERIPHERY (dns/observability/secrets/registries/storage) may diverge.
		const core = {
			cloud_provider: identity.provider,
			cloud_identity_id: identity.id,
			region: spec.region,
		};

		const foreignIds = Array.from(
			new Set(
				[
					network?.cloud_identity_id,
					cluster?.cloud_identity_id,
					dns?.cloud_identity_id,
					observability?.cloud_identity_id,
					...databases.map((d) => d.cloud_identity_id),
					...caches.map((c) => c.cloud_identity_id),
					...queues.map((q) => q.cloud_identity_id),
					...topics.map((t) => t.cloud_identity_id),
					...nosqlTables.map((n) => n.cloud_identity_id),
					...secrets.map((s) => s.cloud_identity_id),
					...containerRegistries.map((r) => r.cloud_identity_id),
				].filter(
					(id): id is string => typeof id === "string" && id !== identity.id,
				),
			),
		);

		const providerById = new Map<string, string>([
			[identity.id, identity.provider],
		]);
		if (foreignIds.length > 0) {
			const rows = await tx
				.select({ id: cloudIdentities.id, provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(inArray(cloudIdentities.id, foreignIds));
			for (const r of rows) providerById.set(r.id, r.provider);
		}

		/** Concrete { cloud_provider, cloud_identity_id, region } for a component row. */
		const resolvePlacement = (row?: {
			cloud_identity_id?: string | null;
			region?: string | null;
		}) => {
			const cid = row?.cloud_identity_id ?? core.cloud_identity_id;
			return {
				cloud_provider: providerById.get(cid) ?? core.cloud_provider,
				cloud_identity_id: cid,
				region: row?.region ?? core.region,
			};
		};

		// Gate: CORE resources must stay on the primary cloud identity.
		const coreChecks: Array<{
			type: string;
			name: string;
			cid?: string | null;
		}> = [
			{ type: "network", name: "network", cid: network?.cloud_identity_id },
			{ type: "cluster", name: "cluster", cid: cluster?.cloud_identity_id },
			...databases.map((d) => ({
				type: "database",
				name: d.name,
				cid: d.cloud_identity_id,
			})),
			...caches.map((c) => ({
				type: "cache",
				name: c.name,
				cid: c.cloud_identity_id,
			})),
			...queues.map((q) => ({
				type: "queue",
				name: q.name,
				cid: q.cloud_identity_id,
			})),
			...topics.map((t) => ({
				type: "topic",
				name: t.name,
				cid: t.cloud_identity_id,
			})),
			...nosqlTables.map((n) => ({
				type: "nosql table",
				name: n.name,
				cid: n.cloud_identity_id,
			})),
		];
		for (const c of coreChecks) {
			if (c.cid && c.cid !== identity.id) {
				throw placementGateError(c.type, c.name);
			}
		}

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
			// M1: the Go provisioner reads `environment_stage` (frozen wire key) for the
			// tofu state path + the `environment` tfvar — feed it the environment's name.
			environment_stage: environment.name,
			region: environment.region ?? spec.region,
			provider: identity.provider,
			network: {
				...resolvePlacement(network),
				provision_network: network?.provision_network ?? true,
				cidr_block: network?.cidr_block ?? "10.0.0.0/16",
				network_id: network?.network_id,
				single_nat_gateway: network?.single_nat_gateway ?? true,
			},
			cluster: {
				...resolvePlacement(cluster),
				cluster_version: cluster?.cluster_version,
				instance_types: cluster?.instance_types ?? [],
				node_min_size: cluster?.node_min_size ?? 2,
				node_max_size: cluster?.node_max_size ?? 5,
				node_desired_size: cluster?.node_desired_size ?? 2,
				cluster_admins: cluster?.cluster_admins ?? [],
				provider_config: cluster?.provider_config ?? {},
			},
			dns: {
				...resolvePlacement(dns),
				enabled: dns?.enabled ?? false,
				// Pluggable DNS provider slug ("" / "native" = cloud-native).
				provider: dns?.provider ?? "",
				zone_id: dns?.zone_id,
				domain_name: dns?.domain_name,
				provider_config: dns?.provider_config ?? {},
			},
			observability: {
				...resolvePlacement(observability),
				enabled: observability?.enabled ?? false,
				provider: observability?.provider ?? "",
				provider_config: observability?.provider_config ?? {},
			},
			repositories: {
				apps_destination_repo: repos?.apps_destination_repo,
			},
			databases: databases.map((d) => ({ ...d, ...resolvePlacement(d) })),
			caches: caches.map((c) => ({ ...c, ...resolvePlacement(c) })),
			queues: queues.map((q) => ({ ...q, ...resolvePlacement(q) })),
			topics: topics.map((t) => ({ ...t, ...resolvePlacement(t) })),
			nosql_tables: nosqlTables.map((n) => ({ ...n, ...resolvePlacement(n) })),
			secrets: secrets.map((s) => ({ ...s, ...resolvePlacement(s) })),
			container_registries: containerRegistries.map((r) => ({
				...r,
				...resolvePlacement(r),
			})),
			// Token is fetched at runtime by the runner via POST /api/jobs/[id]/git-token.
			git_access_token: "",
		};

		return { spec, identity, environment, configSnapshot };
	});
}

/**
 * Resolves the environment a provisioning job targets: the explicitly-passed one
 * (verified to belong to the spec), else the spec's default environment.
 */
async function resolveTargetEnvironment(
	tx: Parameters<Parameters<typeof withOwnerScope>[1]>[0],
	specId: string,
	environmentId?: string | null,
): Promise<SpecEnvironment> {
	if (environmentId) {
		const [env] = await tx
			.select()
			.from(specEnvironments)
			.where(
				and(
					eq(specEnvironments.id, environmentId),
					eq(specEnvironments.spec_id, specId),
				),
			)
			.limit(1);
		if (!env) throw new Error("Environment not found for this spec");
		return env;
	}
	const [env] = await tx
		.select()
		.from(specEnvironments)
		.where(
			and(
				eq(specEnvironments.spec_id, specId),
				eq(specEnvironments.is_default, true),
			),
		)
		.limit(1);
	if (!env) throw new Error("Spec has no default environment");
	return env;
}

export async function planSpec(
	specId: string,
	runnerId?: string | null,
	environmentId?: string | null,
) {
	const actor = await authorize("plan", { type: "spec", id: specId });
	await assertUsageAllowed(actor.orgId);
	const owner = actor.userId;
	const { spec, identity, environment, configSnapshot } =
		await buildConfigSnapshot(owner, specId, environmentId);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				spec_id: specId,
				environment_id: environment.id,
				zone_id: spec.zone_id ?? null,
				cloud_identity_id: identity.id,
				job_type: "PLAN",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(runnerId ? { assigned_runner_id: runnerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx
			.update(specEnvironments)
			.set({ status: "QUEUED" })
			.where(eq(specEnvironments.id, environment.id));
		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

export async function provisionSpec(
	specId: string,
	planJobId?: string,
	runnerId?: string | null,
	environmentId?: string | null,
) {
	const actor = await authorize("deploy", { type: "spec", id: specId });
	await assertUsageAllowed(actor.orgId);
	const owner = actor.userId;
	const { spec, identity, environment, configSnapshot } =
		await buildConfigSnapshot(owner, specId, environmentId);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				spec_id: specId,
				environment_id: environment.id,
				zone_id: spec.zone_id ?? null,
				cloud_identity_id: identity.id,
				job_type: "DEPLOY",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(planJobId ? { plan_job_id: planJobId } : {}),
				...(runnerId ? { assigned_runner_id: runnerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx
			.update(specEnvironments)
			.set({ status: "QUEUED" })
			.where(eq(specEnvironments.id, environment.id));

		await tx.insert(auditLog).values({
			spec_id: specId,
			user_id: owner,
			action: "PROVISIONED",
			changes: { job_id: job.id, environment_id: environment.id },
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
			iac_version: source.spec.iac_version,
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

// ============================================================
// Environments (M1) — a spec owns N independently-provisionable environments.
// ============================================================

/** Lists a spec's environments (default first, then by creation). */
export async function getSpecEnvironments(specId: string) {
	const actor = await authorize("view", { type: "spec", id: specId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const environments = await tx
			.select()
			.from(specEnvironments)
			.where(eq(specEnvironments.spec_id, specId))
			.orderBy(desc(specEnvironments.is_default), specEnvironments.created_at);
		return { environments };
	});
}

/**
 * Adds an environment to a spec. The `name` is slugified (it feeds the tofu state
 * path + the URL); it inherits the spec's region unless one is given. Never default.
 */
export async function addEnvironment(
	specId: string,
	input: { name: string; stage: EnvironmentStage; region?: string | null },
) {
	const actor = await authorize("edit", { type: "spec", id: specId });
	const owner = actor.userId;
	const name = slugifyEnvName(input.name);
	if (!name) throw new Error("Environment name is required");
	return withOwnerScope(owner, async (tx) => {
		const [spec] = await tx
			.select({ org_id: specs.org_id })
			.from(specs)
			.where(eq(specs.id, specId))
			.limit(1);
		if (!spec) throw new Error("Spec not found");
		const [env] = await tx
			.insert(specEnvironments)
			.values({
				spec_id: specId,
				user_id: owner,
				org_id: spec.org_id,
				name,
				stage: input.stage,
				status: "DRAFT",
				is_default: false,
				region: input.region ?? null,
			})
			.returning();
		return { environment: env };
	});
}

/** Deletes a non-default environment (the default is the spec's anchor). */
export async function deleteEnvironment(specId: string, environmentId: string) {
	const actor = await authorize("edit", { type: "spec", id: specId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [env] = await tx
			.select()
			.from(specEnvironments)
			.where(
				and(
					eq(specEnvironments.id, environmentId),
					eq(specEnvironments.spec_id, specId),
				),
			)
			.limit(1);
		if (!env) throw new Error("Environment not found for this spec");
		if (env.is_default)
			throw new Error("Cannot delete the spec's default environment");
		await tx.delete(specEnvironments).where(eq(specEnvironments.id, environmentId));
		return { success: true };
	});
}

/** Lowercases + slugifies an environment name (a-z0-9 and single dashes). */
function slugifyEnvName(raw: string): string {
	return raw
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
