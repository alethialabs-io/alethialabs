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
	type Project,
	type ProjectEnvironment,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectNetwork,
	projectNosqlTables,
	projectObservability,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectTopics,
	projects,
} from "@/lib/db/schema";
import {
	type CloudProviderSlug,
	type ConversionWarning,
	convertProjectConfig,
} from "@/lib/cloud-providers";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { notifyScaler } from "@/lib/scaler";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import { pickFreeSlug, RESERVED_PROJECT_CHILD_SLUGS, slugify } from "@/lib/routing";
import { and, desc, eq, inArray } from "drizzle-orm";

/**
 * Mirrors the Go provisioner gate (packages/core/provisioner/placement.go):
 * a CORE resource placed on a cloud account other than the project's primary one is
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
// Types — form-facing shapes mapped to the project DB columns below.
// ============================================================

type ComponentInsert<T> = Omit<
	T,
	| "id"
	| "project_id"
	| "status"
	| "status_message"
	| "estimated_monthly_cost"
	| "created_at"
	| "updated_at"
>;

export interface CreateProjectInput {
	project: {
		project_name: string;
		// M1: the project's INITIAL environment — createProject turns this into the project's
		// default `project_environments` row (name + stage), not a column on `projects`.
		environment_stage: EnvironmentStage;
		region: string;
		cloud_identity_id?: string | null;
		iac_version: string;
	};
	network: ComponentInsert<typeof projectNetwork.$inferInsert>;
	cluster: Omit<
		ComponentInsert<typeof projectCluster.$inferInsert>,
		"cluster_name" | "cluster_endpoint"
	>;
	dns: ComponentInsert<typeof projectDns.$inferInsert>;
	repositories: Omit<
		typeof projectRepositories.$inferInsert,
		"id" | "project_id" | "created_at" | "updated_at"
	>;
	databases?: Omit<
		ComponentInsert<typeof projectDatabases.$inferInsert>,
		"endpoint" | "reader_endpoint"
	>[];
	caches?: Omit<
		ComponentInsert<typeof projectCaches.$inferInsert>,
		"endpoint"
	>[];
	queues?: ComponentInsert<typeof projectQueues.$inferInsert>[];
	topics?: ComponentInsert<typeof projectTopics.$inferInsert>[];
	nosql_tables?: ComponentInsert<typeof projectNosqlTables.$inferInsert>[];
	secrets?: ComponentInsert<typeof projectSecrets.$inferInsert>[];
}

// ============================================================
// Create
// ============================================================

export async function createProject(data: CreateProjectInput) {
	const actor = await authorize("create", { type: "project" });
	const owner = actor.userId;

	return withOwnerScope(owner, async (tx) => {
		// M1: environment_stage is no longer a project column — it seeds the default env.
		const { environment_stage, ...projectFields } = data.project;

		// Projects are top-level under the org: derive a unique-per-org URL slug from the name
		// (RLS scopes this select to the active org).
		const existing = await tx.select({ slug: projects.slug }).from(projects);
		const slug = pickFreeSlug(
			slugify(projectFields.project_name) || "project",
			// Skip reserved project-child segments (e.g. "settings") so a project slug can never
			// shadow the project-scoped settings route.
			[...existing.map((r) => r.slug), ...RESERVED_PROJECT_CHILD_SLUGS],
		);

		const [project] = await tx
			.insert(projects)
			.values({ ...projectFields, slug, user_id: owner })
			.returning();

		if (!project) throw new Error("Failed to create project");

		// The project's default (and, for now, only) environment. `name` = the chosen
		// stage value so the tofu/S3 state path matches the legacy single-env path.
		await tx.insert(projectEnvironments).values({
			project_id: project.id,
			user_id: owner,
			org_id: project.org_id,
			name: environment_stage,
			stage: environment_stage,
			status: "DRAFT",
			is_default: true,
			region: projectFields.region,
		});

		// Authz hierarchy edge: project → org, so an org-wide grant flows down to this project.
		await tx
			.insert(resourceHierarchy)
			.values({
				child_type: "project",
				child_id: project.id,
				parent_type: "org",
				parent_id: owner,
			})
			.onConflictDoNothing();
		mirrorHierarchyEdge("project", project.id, "org", owner);

		// Singleton components (tx rolls back automatically on any failure).
		await tx.insert(projectNetwork).values({ project_id: project.id, ...data.network });
		await tx.insert(projectCluster).values({ project_id: project.id, ...data.cluster });
		await tx.insert(projectDns).values({ project_id: project.id, ...data.dns });
		await tx
			.insert(projectRepositories)
			.values({ project_id: project.id, ...data.repositories });

		if (data.databases?.length) {
			await tx
				.insert(projectDatabases)
				.values(data.databases.map((db) => ({ project_id: project.id, ...db })));
		}
		if (data.caches?.length) {
			await tx
				.insert(projectCaches)
				.values(data.caches.map((c) => ({ project_id: project.id, ...c })));
		}
		if (data.queues?.length) {
			await tx
				.insert(projectQueues)
				.values(data.queues.map((q) => ({ project_id: project.id, ...q })));
		}
		if (data.topics?.length) {
			await tx
				.insert(projectTopics)
				.values(data.topics.map((t) => ({ project_id: project.id, ...t })));
		}
		if (data.nosql_tables?.length) {
			await tx
				.insert(projectNosqlTables)
				.values(data.nosql_tables.map((n) => ({ project_id: project.id, ...n })));
		}
		if (data.secrets?.length) {
			await tx
				.insert(projectSecrets)
				.values(data.secrets.map((s) => ({ project_id: project.id, ...s })));
		}

		await tx.insert(auditLog).values({
			project_id: project.id,
			user_id: owner,
			action: "CREATED",
			changes: {
				project_name: data.project.project_name,
				environment: data.project.environment_stage,
			},
		});

		return { project };
	});
}

// ============================================================
// Read
// ============================================================

export async function getProjectsList() {
	const actor = await authorize("view", { type: "project" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		// M1: surface each project's default-environment name + status (the columns moved
		// off `projects` into project_environments) so list consumers keep reading them.
		const rows = await tx
			.select({
				project: projects,
				env_name: projectEnvironments.name,
				env_status: projectEnvironments.status,
			})
			.from(projects)
			.leftJoin(
				projectEnvironments,
				and(
					eq(projectEnvironments.project_id, projects.id),
					eq(projectEnvironments.is_default, true),
				),
			)
			.orderBy(projects.created_at);
		const projectList = rows.map((r) => ({
			...r.project,
			environment_stage: r.env_name ?? "development",
			status: r.env_status ?? "DRAFT",
		}));
		return { projects: projectList };
	});
}

export async function getProject(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [project] = await tx
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!project) throw new Error("Project not found");

		const [network] = await tx
			.select()
			.from(projectNetwork)
			.where(eq(projectNetwork.project_id, projectId))
			.limit(1);
		const [cluster] = await tx
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, projectId))
			.limit(1);
		const [dns] = await tx
			.select()
			.from(projectDns)
			.where(eq(projectDns.project_id, projectId))
			.limit(1);
		const [repos] = await tx
			.select()
			.from(projectRepositories)
			.where(eq(projectRepositories.project_id, projectId))
			.limit(1);
		const databases = await tx
			.select()
			.from(projectDatabases)
			.where(eq(projectDatabases.project_id, projectId));
		const caches = await tx
			.select()
			.from(projectCaches)
			.where(eq(projectCaches.project_id, projectId));
		const queues = await tx
			.select()
			.from(projectQueues)
			.where(eq(projectQueues.project_id, projectId));
		const topics = await tx
			.select()
			.from(projectTopics)
			.where(eq(projectTopics.project_id, projectId));
		const nosqlTables = await tx
			.select()
			.from(projectNosqlTables)
			.where(eq(projectNosqlTables.project_id, projectId));
		const secrets = await tx
			.select()
			.from(projectSecrets)
			.where(eq(projectSecrets.project_id, projectId));

		// M1: the project's environments (default first). The default env's name + status
		// surface as `project.environment_stage` / `project.status` so existing single-value
		// reads keep working; the full list drives the Environments management UI.
		const environments = await tx
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId))
			.orderBy(desc(projectEnvironments.is_default), projectEnvironments.created_at);
		const defaultEnv =
			environments.find((e) => e.is_default) ?? environments[0] ?? null;

		let cloudProvider = "aws";
		if (project.cloud_identity_id) {
			const [ci] = await tx
				.select({ provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, project.cloud_identity_id))
				.limit(1);
			if (ci) cloudProvider = ci.provider;
		}

		return {
			project: {
				...project,
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
	projectId: string,
	environmentId?: string | null,
) {
	return withOwnerScope(owner, async (tx) => {
		const [project] = await tx
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!project) throw new Error("Project not found");

		// M1: resolve which environment this job provisions (the given one, else the
		// project's default). Its `name` feeds the frozen snapshot `environment_stage`
		// key → the Go provisioner's tofu/S3 state path, unchanged.
		const environment = await resolveTargetEnvironment(tx, projectId, environmentId);

		if (!project.cloud_identity_id) {
			throw new Error(
				"No cloud account linked to this project. Go to Connectors to connect.",
			);
		}

		const [identity] = await tx
			.select({ id: cloudIdentities.id, provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, project.cloud_identity_id))
			.limit(1);

		if (!identity) {
			throw new Error(
				"Cloud account is not verified. Go to Connectors to verify.",
			);
		}

		const [network] = await tx
			.select()
			.from(projectNetwork)
			.where(eq(projectNetwork.project_id, projectId))
			.limit(1);
		const [cluster] = await tx
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, projectId))
			.limit(1);
		const [dns] = await tx
			.select()
			.from(projectDns)
			.where(eq(projectDns.project_id, projectId))
			.limit(1);
		const [repos] = await tx
			.select()
			.from(projectRepositories)
			.where(eq(projectRepositories.project_id, projectId))
			.limit(1);
		const databases = await tx
			.select()
			.from(projectDatabases)
			.where(eq(projectDatabases.project_id, projectId));
		const caches = await tx
			.select()
			.from(projectCaches)
			.where(eq(projectCaches.project_id, projectId));
		const queues = await tx
			.select()
			.from(projectQueues)
			.where(eq(projectQueues.project_id, projectId));
		const topics = await tx
			.select()
			.from(projectTopics)
			.where(eq(projectTopics.project_id, projectId));
		const nosqlTables = await tx
			.select()
			.from(projectNosqlTables)
			.where(eq(projectNosqlTables.project_id, projectId));
		const secrets = await tx
			.select()
			.from(projectSecrets)
			.where(eq(projectSecrets.project_id, projectId));
		const containerRegistries = await tx
			.select()
			.from(projectContainerRegistries)
			.where(eq(projectContainerRegistries.project_id, projectId));
		const [observability] = await tx
			.select()
			.from(projectObservability)
			.where(eq(projectObservability.project_id, projectId))
			.limit(1);

		// ── Resolve per-resource placement ("versatile model") ───────────────
		// Each component may carry its own cloud_identity_id/region; NULL inherits
		// the project's primary identity. Resolve every component to a concrete
		// placement and enforce the provisioning gate (mirrors the Go
		// ValidatePlacement): CORE resources must colocate on the primary cloud;
		// PERIPHERY (dns/observability/secrets/registries/storage) may diverge.
		const core = {
			cloud_provider: identity.provider,
			cloud_identity_id: identity.id,
			region: project.region,
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
				`Cannot plan: no ${netLabel} selected. Edit the project's network settings or enable network provisioning.`,
			);
		}

		const configSnapshot = {
			...project,
			// M1: the Go provisioner reads `environment_stage` (frozen wire key) for the
			// tofu state path + the `environment` tfvar — feed it the environment's name.
			environment_stage: environment.name,
			region: environment.region ?? project.region,
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

		return { project, identity, environment, configSnapshot };
	});
}

/**
 * Resolves the environment a provisioning job targets: the explicitly-passed one
 * (verified to belong to the project), else the project's default environment.
 */
async function resolveTargetEnvironment(
	tx: Parameters<Parameters<typeof withOwnerScope>[1]>[0],
	projectId: string,
	environmentId?: string | null,
): Promise<ProjectEnvironment> {
	if (environmentId) {
		const [env] = await tx
			.select()
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.id, environmentId),
					eq(projectEnvironments.project_id, projectId),
				),
			)
			.limit(1);
		if (!env) throw new Error("Environment not found for this project");
		return env;
	}
	const [env] = await tx
		.select()
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.project_id, projectId),
				eq(projectEnvironments.is_default, true),
			),
		)
		.limit(1);
	if (!env) throw new Error("Project has no default environment");
	return env;
}

export async function planProject(
	projectId: string,
	runnerId?: string | null,
	environmentId?: string | null,
) {
	const actor = await authorize("plan", { type: "project", id: projectId });
	await assertUsageAllowed(actor.orgId);
	const owner = actor.userId;
	const { project, identity, environment, configSnapshot } =
		await buildConfigSnapshot(owner, projectId, environmentId);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				project_id: projectId,
				environment_id: environment.id,
				cloud_identity_id: identity.id,
				job_type: "PLAN",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(runnerId ? { assigned_runner_id: runnerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx
			.update(projectEnvironments)
			.set({ status: "QUEUED" })
			.where(eq(projectEnvironments.id, environment.id));
		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

export async function provisionProject(
	projectId: string,
	planJobId?: string,
	runnerId?: string | null,
	environmentId?: string | null,
) {
	const actor = await authorize("deploy", { type: "project", id: projectId });
	await assertUsageAllowed(actor.orgId);
	const owner = actor.userId;
	const { project, identity, environment, configSnapshot } =
		await buildConfigSnapshot(owner, projectId, environmentId);

	const result = await withOwnerScope(owner, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				project_id: projectId,
				environment_id: environment.id,
				cloud_identity_id: identity.id,
				job_type: "DEPLOY",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				...(planJobId ? { plan_job_id: planJobId } : {}),
				...(runnerId ? { assigned_runner_id: runnerId } : {}),
			})
			.returning({ id: jobs.id });

		await tx
			.update(projectEnvironments)
			.set({ status: "QUEUED" })
			.where(eq(projectEnvironments.id, environment.id));

		await tx.insert(auditLog).values({
			project_id: projectId,
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

export async function deleteProject(projectId: string) {
	const actor = await authorize("destroy", { type: "project", id: projectId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		// CASCADE handles all component tables.
		await tx.delete(projects).where(eq(projects.id, projectId));
		return { success: true };
	});
}

// ============================================================
// Duplicate for another provider
// ============================================================

/** Converts a project's DB representation to ProjectFormData for duplication / pre-populating forms. */
export async function getProjectAsFormData(
	projectId: string,
): Promise<{ formData: ProjectFormData; provider: CloudProviderSlug }> {
	const source = await getProject(projectId);

	let provider: CloudProviderSlug = "aws";
	if (source.project.cloud_identity_id) {
		const owner = await requireOwner();
		const ci = await withOwnerScope(owner, async (tx) => {
			const [row] = await tx
				.select({ provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, source.project.cloud_identity_id!))
				.limit(1);
			return row;
		});
		if (!ci) throw new Error("Cloud identity not found");
		provider = ci.provider as CloudProviderSlug;
	}

	const formData: ProjectFormData = {
		project: {
			project_name: source.project.project_name,
			environment_stage: source.project.environment_stage,
			region: source.project.region,
			cloud_identity_id: source.project.cloud_identity_id ?? "",
			iac_version: source.project.iac_version,
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
	} as ProjectFormData;

	return { formData, provider };
}

/** Duplicates a project config for a different cloud provider, mapping provider-specific values. */
export async function duplicateProjectForProvider(
	sourceProjectId: string,
	targetCloudIdentityId: string,
	targetRegion: string,
): Promise<{
	newProjectId: string;
	warnings: ConversionWarning[];
}> {
	const actor = await authorize("create", { type: "project" });
	const owner = actor.userId;

	const { formData, provider: sourceProvider } =
		await getProjectAsFormData(sourceProjectId);

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

	const { data: converted, warnings } = convertProjectConfig(
		formData,
		sourceProvider,
		targetProvider,
	);

	converted.project.region = targetRegion;
	converted.project.cloud_identity_id = targetCloudIdentityId;

	const input = converted as unknown as CreateProjectInput;
	const { project } = await createProject(input);

	return {
		newProjectId: project.id,
		warnings,
	};
}

// ============================================================
// Environments (M1) — a project owns N independently-provisionable environments.
// ============================================================

/** Lists a project's environments (default first, then by creation). */
export async function getProjectEnvironments(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const environments = await tx
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId))
			.orderBy(desc(projectEnvironments.is_default), projectEnvironments.created_at);
		return { environments };
	});
}

/**
 * Adds an environment to a project. The `name` is slugified (it feeds the tofu state
 * path + the URL); it inherits the project's region unless one is given. Never default.
 */
export async function addEnvironment(
	projectId: string,
	input: { name: string; stage: EnvironmentStage; region?: string | null },
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	const name = slugifyEnvName(input.name);
	if (!name) throw new Error("Environment name is required");
	return withOwnerScope(owner, async (tx) => {
		const [project] = await tx
			.select({ org_id: projects.org_id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!project) throw new Error("Project not found");
		const [env] = await tx
			.insert(projectEnvironments)
			.values({
				project_id: projectId,
				user_id: owner,
				org_id: project.org_id,
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

/** Deletes a non-default environment (the default is the project's anchor). */
export async function deleteEnvironment(projectId: string, environmentId: string) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [env] = await tx
			.select()
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.id, environmentId),
					eq(projectEnvironments.project_id, projectId),
				),
			)
			.limit(1);
		if (!env) throw new Error("Environment not found for this project");
		if (env.is_default)
			throw new Error("Cannot delete the project's default environment");
		await tx.delete(projectEnvironments).where(eq(projectEnvironments.id, environmentId));
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

// ============================================================
// Flat project list.
// ============================================================

// The environment identity (name) + provisioning status live on project_environments. These
// derived fields surface the project's DEFAULT environment so single-value UI (project cards,
// switchers, detail header) reads `project.environment_stage` / `project.status` directly.
export type ProjectWithProvider = Project & {
	cloud_provider: string | null;
	environment_stage: string;
	status: string;
	default_environment_id: string | null;
};

/** The project + its default environment + cloud provider, the shape every project surface reads. */
function projectSelect() {
	return {
		project: projects,
		cloud_provider: cloudIdentities.provider,
		env_id: projectEnvironments.id,
		env_name: projectEnvironments.name,
		env_status: projectEnvironments.status,
	};
}

/** Maps a joined project row into the derived ProjectWithProvider shape. */
function toProject(r: {
	project: Project;
	cloud_provider: string | null;
	env_id: string | null;
	env_name: string | null;
	env_status: string | null;
}): ProjectWithProvider {
	return {
		...r.project,
		cloud_provider: r.cloud_provider ?? null,
		environment_stage: r.env_name ?? "development",
		status: r.env_status ?? "DRAFT",
		default_environment_id: r.env_id ?? null,
	};
}

/** All of the active org's projects (projects), newest first, each with its default environment. */
export async function getProjects(): Promise<ProjectWithProvider[]> {
	const actor = await authorize("view", { type: "project" });
	return withOwnerScope(actor.userId, async (tx) => {
		const rows = await tx
			.select(projectSelect())
			.from(projects)
			.leftJoin(cloudIdentities, eq(projects.cloud_identity_id, cloudIdentities.id))
			.leftJoin(
				projectEnvironments,
				and(
					eq(projectEnvironments.project_id, projects.id),
					eq(projectEnvironments.is_default, true),
				),
			)
			.orderBy(desc(projects.created_at));
		return rows.map(toProject);
	});
}
