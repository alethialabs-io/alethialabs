"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { asCloudProviderSlug } from "@/lib/cloud-providers/registry";
import { signedJob } from "@/lib/db/signed-job";
import { authorize, currentActor } from "@/lib/authz/guard";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { getServiceDb, type Tx, withActorScope, withScope } from "@/lib/db";
import { insertServiceBindings } from "@/lib/db/service-bindings-sync";
import { type EnvTransitionContext, transitionEnv } from "@/lib/db/env-status";
import {
	auditLog,
	cloudIdentities,
	type EnvironmentStage,
	jobs,
	type Project,
	type ProjectEnvironment,
	type ProjectFabric,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectChartWorkloads,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectFabrics,
	projectAddons,
	projectIacSources,
	projectNetwork,
	projectNosqlTables,
	projectObservability,
	projectQueues,
	projectRepositories,
	projectSourceRepos,
	projectSecrets,
	projectServices,
	projectStorageBuckets,
	projectTopics,
	projects,
	clusterAdmins,
	topicSubscriptions,
} from "@/lib/db/schema";
import {
	resolveAddOnInstall,
	resolveByoChartInstall,
} from "@/lib/addons/catalog";
import type { ChartWorkloadOverlay } from "@/lib/addons/chart-overlay";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import type { AddOnInstallSpec } from "@/lib/addons/types";
import { resolveClassificationSnapshot } from "@/lib/classification/snapshot";
import { listAssignmentsFor } from "@/lib/queries/classification";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import {
	HETZNER_DB_ENGINES,
	hetznerDataServicesToAddOns,
} from "@/lib/cloud-providers/hetzner-services";
import { unsupportedKindsFor } from "@/lib/cloud-providers/unsupported-kinds";
import {
	type CloudProviderSlug,
	type ConversionWarning,
	convertProjectConfig,
	DEFAULT_K8S_VERSION,
	getProvider,
} from "@/lib/cloud-providers";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { newTraceparent } from "@/lib/observability/trace";
import { notifyScaler } from "@/lib/scaler";
import { designInventory } from "@/lib/promotions/diff";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import { RESERVED_PROJECT_CHILD_SLUGS, slugify } from "@/lib/routing";
import { repoLabel } from "@/lib/repos/repo-label";
import { type AnyColumn, and, desc, eq, inArray } from "drizzle-orm";

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

/**
 * Deploy-time honesty gate (fail-closed), mirroring placementGateError's fail-fast shape:
 * Hetzner runs databases in-cluster via CloudNativePG, which is PostgreSQL-only. The palette,
 * inspector, and cross-cloud converter all filter the engine choice, but imported / AI-authored
 * / legacy configs can still carry another family — and without this gate the chart mapper
 * silently skips the database, so the deploy reports SUCCESS without it.
 */
function hetznerDbEngineGateError(name: string, engineFamily: string): Error {
	const label = engineFamily === "mysql" ? "MySQL" : `"${engineFamily}"`;
	return new Error(
		`Database "${name}": ${label} databases can't be provisioned on Hetzner — the in-cluster ` +
			"CloudNativePG operator supports PostgreSQL only. Switch the database engine to PostgreSQL " +
			"or move the stack to a cloud with a managed service for this engine.",
	);
}

/**
 * Deploy-time honesty gate (fail-closed), same shape/placement as hetznerDbEngineGateError:
 * reject a component whose KIND the target cloud's built-in template can't provision. The palette
 * hides these kinds per provider (UNSUPPORTED_KINDS_BY_PROVIDER, node-registry.ts), but a
 * cloud-switch or an AI-composed graph can still carry one — and without this gate the snapshot
 * mapper silently drops it, so the deploy reports SUCCESS without the component. The blocked set is
 * derived from the SAME single source the palette uses, so un-hiding a kind there disarms the gate.
 */
function unsupportedKindGateError(
	kind: NodeKind,
	provider: string,
	name: string,
): Error {
	const cloud = getProvider(provider).name;
	const hint: Partial<Record<NodeKind, string>> = {
		registry:
			"container registries have no native path — deploy the Harbor marketplace add-on for an in-cluster registry, or move the stack to a cloud with a managed registry",
		bucket:
			"object storage has no native path — deploy the MinIO marketplace add-on for in-cluster S3-compatible storage, or move the stack to a cloud with managed object storage",
		topic:
			"there is no managed pub/sub service — move the stack to a cloud with managed messaging (e.g. AWS SNS)",
		nosql:
			"there is no managed NoSQL service — move the stack to a cloud with one (e.g. AWS DynamoDB)",
		secret:
			"there is no cloud secret store — deploy the Vault marketplace add-on (or connect an external secret store) and reference its secrets from your workloads, or move the stack to a cloud with a managed secret store",
	};
	const detail =
		hint[kind] ?? `"${kind}" components have no provisioning path here`;
	return new Error(
		`Component "${name}" (${kind}) can't be provisioned on ${cloud}: ${detail}.`,
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
	source_repos?: Omit<
		typeof projectSourceRepos.$inferInsert,
		"id" | "project_id" | "created_at" | "updated_at"
	>[];
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
	storage_buckets?: ComponentInsert<
		typeof projectStorageBuckets.$inferInsert
	>[];
	container_registries?: Omit<
		ComponentInsert<typeof projectContainerRegistries.$inferInsert>,
		"repository_url"
	>[];
	// W1 — first-class application workloads. resolved_image is the W2 build's write-back
	// slot (output column, like registries.repository_url) — never part of a create/save.
	services?: Omit<
		ComponentInsert<typeof projectServices.$inferInsert>,
		"resolved_image"
	>[];
}

// ============================================================
// Create
// ============================================================

/** A withOwnerScope transaction handle (the arg drizzle passes the callback). */
type ComponentTx = Parameters<Parameters<typeof withActorScope>[1]>[0];

/** `project_id = … AND environment_id = …` — component rows are scoped to one environment, so
 * every component read/delete filters on both. */
function envScope(
	table: { project_id: AnyColumn; environment_id: AnyColumn },
	projectId: string,
	environmentId: string,
) {
	return and(
		eq(table.project_id, projectId),
		eq(table.environment_id, environmentId),
	);
}

/** Inserts a form's component rows for one (project, environment). The single source of the
 * per-table form→column mapping, shared by createProject / updateProjectDesign /
 * duplicateEnvironment so environment scoping stays consistent across all three. */
async function writeComponents(
	tx: ComponentTx,
	projectId: string,
	environmentId: string,
	data: CreateProjectInput,
) {
	const base = { project_id: projectId, environment_id: environmentId };
	await tx.insert(projectNetwork).values({ ...base, ...data.network });
	// Dual-write the cluster's admins: the row keeps its cluster_admins JSONB (rollback net, dropped
	// in a follow-up) AND each admin is normalized into cluster_admins (username + text[] groups + FK).
	const [insertedCluster] = await tx
		.insert(projectCluster)
		.values({ ...base, ...data.cluster })
		.returning({ id: projectCluster.id });
	if (insertedCluster && data.cluster?.cluster_admins?.length) {
		await tx.insert(clusterAdmins).values(
			data.cluster.cluster_admins.map((a, i) => ({
				cluster_id: insertedCluster.id,
				username: a.username,
				groups: a.groups,
				ordinal: i,
			})),
		);
	}
	await tx.insert(projectDns).values({ ...base, ...data.dns });
	await tx
		.insert(projectRepositories)
		.values({ ...base, ...data.repositories });
	if (data.source_repos?.length)
		await tx
			.insert(projectSourceRepos)
			.values(data.source_repos.map((r) => ({ ...base, ...r })));
	if (data.databases?.length)
		await tx
			.insert(projectDatabases)
			.values(data.databases.map((db) => ({ ...base, ...db })));
	if (data.caches?.length)
		await tx
			.insert(projectCaches)
			.values(data.caches.map((c) => ({ ...base, ...c })));
	if (data.queues?.length)
		await tx
			.insert(projectQueues)
			.values(data.queues.map((q) => ({ ...base, ...q })));
	if (data.topics?.length) {
		// Dual-write: the topic row still carries `subscriptions` JSONB (the rollback net, dropped in a
		// follow-up), AND each subscription is normalized into topic_subscriptions (enum protocol + FK).
		// `ordinal` preserves author order so the config-snapshot array stays byte-identical.
		const insertedTopics = await tx
			.insert(projectTopics)
			.values(data.topics.map((t) => ({ ...base, ...t })))
			.returning({ id: projectTopics.id, name: projectTopics.name });
		const topicIdByName = new Map(insertedTopics.map((r) => [r.name, r.id]));
		const subRows = data.topics.flatMap((t) => {
			const topicId = topicIdByName.get(t.name);
			if (!topicId) return [];
			return (t.subscriptions ?? []).map((s, i) => ({
				topic_id: topicId,
				protocol: s.protocol,
				endpoint: s.endpoint,
				ordinal: i,
			}));
		});
		if (subRows.length) await tx.insert(topicSubscriptions).values(subRows);
	}
	if (data.nosql_tables?.length)
		await tx
			.insert(projectNosqlTables)
			.values(data.nosql_tables.map((n) => ({ ...base, ...n })));
	if (data.secrets?.length)
		await tx
			.insert(projectSecrets)
			.values(data.secrets.map((s) => ({ ...base, ...s })));
	if (data.storage_buckets?.length)
		await tx
			.insert(projectStorageBuckets)
			.values(data.storage_buckets.map((b) => ({ ...base, ...b })));
	if (data.container_registries?.length)
		await tx
			.insert(projectContainerRegistries)
			.values(data.container_registries.map((r) => ({ ...base, ...r })));
	if (data.services?.length) {
		// Dual-write: the service row keeps its bindings JSONB (rollback net) AND each binding is
		// normalized into service_bindings (+ its injections). Keyed by service name (unique per env).
		const insertedServices = await tx
			.insert(projectServices)
			.values(data.services.map((s) => ({ ...base, ...s })))
			.returning({ id: projectServices.id, name: projectServices.name });
		const svcIdByName = new Map(insertedServices.map((r) => [r.name, r.id]));
		for (const s of data.services) {
			const serviceId = svcIdByName.get(s.name);
			if (serviceId && s.bindings?.length) {
				await insertServiceBindings(tx, { service_id: serviceId }, s.bindings);
			}
		}
	}
}

/** Deletes every component row for one (project, environment) — the delete half of the canvas
 * delete-then-insert reconcile, scoped so other environments are untouched. */
async function clearComponents(
	tx: ComponentTx,
	projectId: string,
	environmentId: string,
) {
	await tx
		.delete(projectNetwork)
		.where(envScope(projectNetwork, projectId, environmentId));
	await tx
		.delete(projectCluster)
		.where(envScope(projectCluster, projectId, environmentId));
	await tx
		.delete(projectDns)
		.where(envScope(projectDns, projectId, environmentId));
	await tx
		.delete(projectRepositories)
		.where(envScope(projectRepositories, projectId, environmentId));
	await tx
		.delete(projectSourceRepos)
		.where(envScope(projectSourceRepos, projectId, environmentId));
	await tx
		.delete(projectDatabases)
		.where(envScope(projectDatabases, projectId, environmentId));
	await tx
		.delete(projectCaches)
		.where(envScope(projectCaches, projectId, environmentId));
	await tx
		.delete(projectQueues)
		.where(envScope(projectQueues, projectId, environmentId));
	await tx
		.delete(projectTopics)
		.where(envScope(projectTopics, projectId, environmentId));
	await tx
		.delete(projectNosqlTables)
		.where(envScope(projectNosqlTables, projectId, environmentId));
	await tx
		.delete(projectSecrets)
		.where(envScope(projectSecrets, projectId, environmentId));
	await tx
		.delete(projectStorageBuckets)
		.where(envScope(projectStorageBuckets, projectId, environmentId));
	await tx
		.delete(projectContainerRegistries)
		.where(envScope(projectContainerRegistries, projectId, environmentId));
	await tx
		.delete(projectServices)
		.where(envScope(projectServices, projectId, environmentId));
}

export async function createProject(data: CreateProjectInput) {
	const actor = await authorize("create", { type: "project" });
	const owner = actor.userId;
	// A project belongs to the ACTIVE ORG, not the creating user. In the community build these are the
	// same value (`actor.orgId === userId`), so everything below is byte-identical there. They diverge
	// only under EE, where the active org is a real multi-member organization — and that divergence is
	// the whole bug: `withOwnerScope`/the `set_org_id` trigger stamped `org_id = user_id`, so every read
	// (which filters `projects.org_id = actor.orgId`) missed the project and its own creator couldn't
	// see it. Scope the whole transaction to the org and stamp the org id explicitly.
	const orgId = actor.orgId;

	return withScope({ ownerId: owner, orgId }, async (tx) => {
		// M1: environment_stage is no longer a project column — it seeds the default env.
		const { environment_stage, ...projectFields } = data.project;

		// The default Fabric + Prod(dedicated)/Preview(namespace) placement + project→org edge are
		// the shared front-door invariant — the SAME core the CLI route (POST /api/cli/projects)
		// runs, so the two creation paths can never drift.
		const { project, defaultEnv } = await insertProjectWithDefaultFabric(tx, {
			project_name: projectFields.project_name,
			region: projectFields.region,
			cloud_identity_id: projectFields.cloud_identity_id ?? null,
			iac_version: projectFields.iac_version,
			environment_stage,
			owner,
			orgId,
		});

		// Components belong to the default environment (tx rolls back on any failure).
		await writeComponents(tx, project.id, defaultEnv.id, data);

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

/**
 * Reconcile an existing project's components to the desired canvas config (the
 * `graphToForm` output). Config is treated as desired-state: each singleton is rewritten
 * and array components (databases/caches/queues/topics/nosql/secrets/buckets/registries) are replaced to
 * match `data`, all in one tx. Provisioned outputs/status repopulate on the next deploy
 * via finalizeDeployment. The canvas persists through this (via applyStagedChanges) so an
 * existing project is *edited* rather than re-created.
 */
export async function updateProjectDesign(
	projectId: string,
	environmentId: string,
	data: CreateProjectInput,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	return withActorScope(actor, async (tx) => {
		// environment_stage seeds the default env at create time; not a project column.
		const { environment_stage, ...projectFields } = data.project;
		void environment_stage;
		await tx
			.update(projects)
			.set(projectFields)
			.where(eq(projects.id, projectId));

		// Reconcile THIS environment's components only (delete-then-insert within the tx);
		// other environments of the project keep their own config.
		await clearComponents(tx, projectId, environmentId);
		await writeComponents(tx, projectId, environmentId, data);

		await tx.insert(auditLog).values({
			project_id: projectId,
			user_id: owner,
			action: "UPDATED",
			changes: { project_name: data.project.project_name },
		});

		return { success: true };
	});
}

// ============================================================
// Read
// ============================================================

export async function getProjectsList() {
	const actor = await authorize("view", { type: "project" });
	const owner = actor.userId;
	return withActorScope(actor, async (tx) => {
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

export async function getProject(
	projectId: string,
	environmentId?: string | null,
) {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const [project] = await tx
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		// A stale/deleted project id (e.g. after resolveProjectId, or a crawler) is a 404, not a bug —
		// notFound() renders the not-found page and the onRequestError filter treats it as expected.
		if (!project) notFound();

		// M1: the project's environments (default first). The active env (the given one, else the
		// default) surfaces as `project.environment_stage` / `project.status` and scopes the
		// component reads — config is environment-scoped, so each env loads its own services.
		const environments = await tx
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId))
			.orderBy(
				desc(projectEnvironments.is_default),
				projectEnvironments.created_at,
			);
		const defaultEnv =
			environments.find((e) => e.is_default) ?? environments[0] ?? null;
		const activeEnv =
			(environmentId
				? environments.find((e) => e.id === environmentId)
				: undefined) ?? defaultEnv;

		/** Reads one environment's component rows (env-scoped). */
		async function readComponents(envId: string) {
			const [network] = await tx
				.select()
				.from(projectNetwork)
				.where(envScope(projectNetwork, projectId, envId))
				.limit(1);
			const [cluster] = await tx
				.select()
				.from(projectCluster)
				.where(envScope(projectCluster, projectId, envId))
				.limit(1);
			const [dns] = await tx
				.select()
				.from(projectDns)
				.where(envScope(projectDns, projectId, envId))
				.limit(1);
			const [repos] = await tx
				.select()
				.from(projectRepositories)
				.where(envScope(projectRepositories, projectId, envId))
				.limit(1);
			const sourceRepos = await tx
				.select()
				.from(projectSourceRepos)
				.where(envScope(projectSourceRepos, projectId, envId));
			const databases = await tx
				.select()
				.from(projectDatabases)
				.where(envScope(projectDatabases, projectId, envId));
			const caches = await tx
				.select()
				.from(projectCaches)
				.where(envScope(projectCaches, projectId, envId));
			const queues = await tx
				.select()
				.from(projectQueues)
				.where(envScope(projectQueues, projectId, envId));
			const topics = await tx
				.select()
				.from(projectTopics)
				.where(envScope(projectTopics, projectId, envId));
			const nosqlTables = await tx
				.select()
				.from(projectNosqlTables)
				.where(envScope(projectNosqlTables, projectId, envId));
			const secrets = await tx
				.select()
				.from(projectSecrets)
				.where(envScope(projectSecrets, projectId, envId));
			const storageBuckets = await tx
				.select()
				.from(projectStorageBuckets)
				.where(envScope(projectStorageBuckets, projectId, envId));
			const containerRegistries = await tx
				.select()
				.from(projectContainerRegistries)
				.where(envScope(projectContainerRegistries, projectId, envId));
			const services = await tx
				.select()
				.from(projectServices)
				.where(envScope(projectServices, projectId, envId));
			return {
				network: network ?? null,
				cluster: cluster ?? null,
				dns: dns ?? null,
				repositories: repos ?? null,
				source_repos: sourceRepos,
				databases,
				caches,
				queues,
				topics,
				nosql_tables: nosqlTables,
				secrets,
				storage_buckets: storageBuckets,
				container_registries: containerRegistries,
				services,
			};
		}

		const components = activeEnv
			? await readComponents(activeEnv.id)
			: {
					network: null,
					cluster: null,
					dns: null,
					repositories: null,
					source_repos: [],
					databases: [],
					caches: [],
					queues: [],
					topics: [],
					nosql_tables: [],
					secrets: [],
					storage_buckets: [],
					container_registries: [],
					services: [],
				};

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
				// The env being viewed (active), so the canvas/form reflect that environment. Sourced
				// from the env's `stage` pgEnum (a narrow EnvironmentStage), not its free-text `name` —
				// this IS the stage, and it lets getProjectAsFormData drop its narrowing helper.
				environment_stage: activeEnv?.stage ?? "development",
				status: activeEnv?.status ?? "DRAFT",
				default_environment_id: defaultEnv?.id ?? null,
			},
			environments,
			cloudProvider,
			components,
		};
	});
}

/**
 * Reconciles a SINGLE environment's components to `data` (delete-then-insert), leaving the projects
 * row and every other environment untouched. Used by environment promotion to write the merged
 * candidate design into the target env before planning it. Unlike `updateProjectDesign`, it never
 * writes project-level fields (a promotion must not rename/re-region/re-cloud the project).
 */
export async function reconcileEnvironmentComponents(
	projectId: string,
	environmentId: string,
	data: CreateProjectInput,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	return withActorScope(actor, async (tx) => {
		await clearComponents(tx, projectId, environmentId);
		await writeComponents(tx, projectId, environmentId, data);
		return { success: true };
	});
}

// ============================================================
// Provision
// ============================================================

async function buildConfigSnapshot(
	owner: string,
	orgId: string,
	projectId: string,
	environmentId?: string | null,
	jobKind: "plan" | "deploy" | "destroy" | "drift" = "deploy",
) {
	// Scope to the ACTIVE ORG, not just the owner. `withOwnerScope` stamps `org_id = user_id`
	// (community assumption), so under a real multi-member org an ORG-scoped cloud_identity
	// (`scope='org'`, `org_id = actor.orgId ≠ userId`) is invisible → the identity lookup below
	// throws the misleading "Cloud account is not verified". Same fix as createProject.
	return withScope({ ownerId: owner, orgId }, async (tx) => {
		const [project] = await tx
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!project) notFound(); // stale/deleted id → 404, not a captured error

		// M1: resolve which environment this job provisions (the given one, else the
		// project's default). Its `name` feeds the frozen snapshot `environment_stage`
		// key → the Go provisioner's tofu/S3 state path, unchanged.
		// #837: also resolve the Fabric it is placed onto + the effective destination namespace,
		// carried into the snapshot below so the #838 provisioner can route by placement.
		const { environment, fabric, namespace } = await resolveTargetEnvironment(
			tx,
			projectId,
			environmentId,
		);

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

		// Snapshot the TARGET environment's components (config is environment-scoped).
		const envId = environment.id;
		const [network] = await tx
			.select()
			.from(projectNetwork)
			.where(envScope(projectNetwork, projectId, envId))
			.limit(1);
		const [cluster] = await tx
			.select()
			.from(projectCluster)
			.where(envScope(projectCluster, projectId, envId))
			.limit(1);
		const [dns] = await tx
			.select()
			.from(projectDns)
			.where(envScope(projectDns, projectId, envId))
			.limit(1);
		const [repos] = await tx
			.select()
			.from(projectRepositories)
			.where(envScope(projectRepositories, projectId, envId))
			.limit(1);
		const sourceRepos = await tx
			.select()
			.from(projectSourceRepos)
			.where(envScope(projectSourceRepos, projectId, envId));
		const databases = await tx
			.select()
			.from(projectDatabases)
			.where(envScope(projectDatabases, projectId, envId));
		const caches = await tx
			.select()
			.from(projectCaches)
			.where(envScope(projectCaches, projectId, envId));
		const queues = await tx
			.select()
			.from(projectQueues)
			.where(envScope(projectQueues, projectId, envId));
		const topics = await tx
			.select()
			.from(projectTopics)
			.where(envScope(projectTopics, projectId, envId));
		const nosqlTables = await tx
			.select()
			.from(projectNosqlTables)
			.where(envScope(projectNosqlTables, projectId, envId));
		const secrets = await tx
			.select()
			.from(projectSecrets)
			.where(envScope(projectSecrets, projectId, envId));
		const containerRegistries = await tx
			.select()
			.from(projectContainerRegistries)
			.where(envScope(projectContainerRegistries, projectId, envId));
		const storageBuckets = await tx
			.select()
			.from(projectStorageBuckets)
			.where(envScope(projectStorageBuckets, projectId, envId));
		const services = await tx
			.select()
			.from(projectServices)
			.where(envScope(projectServices, projectId, envId));
		const [observability] = await tx
			.select()
			.from(projectObservability)
			.where(envScope(projectObservability, projectId, envId))
			.limit(1);
		// Marketplace add-ons enabled for this environment, resolved against the code catalog
		// into runner-facing install specs (chart coords + merged Helm values). The runner
		// renders one ArgoCD Application per spec on DEPLOY; a retired catalog id resolves to
		// null and is skipped.
		const addonRows = await tx
			.select()
			.from(projectAddons)
			.where(
				and(
					envScope(projectAddons, projectId, envId),
					eq(projectAddons.enabled, true),
				),
			);
		// W5 Lane 2: a BYO chart's described workloads carry a user overlay (config/bindings/
		// value_paths). Load them per BYO addon so `resolveByoChartInstall` can compose the static
		// config onto the chart's pristine values. Keyed by projectAddons.id (the workloads' FK).
		const byoAddonIds = addonRows
			.filter((r) => r.source === "byo")
			.map((r) => r.id);
		const workloadsByAddon = new Map<string, ChartWorkloadOverlay[]>();
		if (byoAddonIds.length > 0) {
			const workloadRows = await tx
				.select({
					addon_id: projectChartWorkloads.addon_id,
					name: projectChartWorkloads.name,
					rendered: projectChartWorkloads.rendered,
					config: projectChartWorkloads.config,
					bindings: projectChartWorkloads.bindings,
					value_paths: projectChartWorkloads.value_paths,
				})
				.from(projectChartWorkloads)
				.where(
					and(
						envScope(projectChartWorkloads, projectId, envId),
						inArray(projectChartWorkloads.addon_id, byoAddonIds),
					),
				);
			for (const w of workloadRows) {
				const list = workloadsByAddon.get(w.addon_id) ?? [];
				list.push({
					name: w.name,
					rendered: w.rendered,
					config: w.config,
					bindings: w.bindings,
					value_paths: w.value_paths,
				});
				workloadsByAddon.set(w.addon_id, list);
			}
		}
		const addons: AddOnInstallSpec[] = addonRows
			.map((r) =>
				// A bring-your-own chart (source='byo') resolves to a git-source spec (chart from the
				// customer's repo); a catalog add-on resolves against the code catalog.
				r.source === "byo"
					? resolveByoChartInstall(
							{
								addon_id: r.addon_id,
								mode: r.mode,
								version: r.version,
								chart_repo: r.chart_repo,
								chart_path: r.chart_path,
								namespace: r.namespace,
								values: r.values,
								values_yaml: r.values_yaml,
							},
							workloadsByAddon.get(r.id) ?? [],
						)
					: resolveAddOnInstall({
							addon_id: r.addon_id,
							mode: r.mode,
							version: r.version,
							values: r.values,
							values_yaml: r.values_yaml,
						}),
			)
			.filter((s): s is AddOnInstallSpec => s !== null);

		// Bring-your-own IaC (E3): when the environment has an ENABLED project_iac_sources row,
		// the customer's OpenTofu root module replaces the built-in per-cloud template for this
		// environment (v1 replace mode). The snapshot then carries `iac_source` and the
		// template-model gates below (core placement + network provisioning) are skipped — the
		// component graph is not the source of truth for what gets provisioned. Components and
		// add-ons still ride the snapshot (the UI reads them; the Go side skips ProviderTfvars
		// for a replace-mode job and ignores what it doesn't need).
		// #839: BYO-IaC attaches at the Fabric (one source per Fabric), so resolve the source by the
		// env's Fabric, not the env. `fabric` is null only for a not-yet-linked transitional env → no
		// BYO source (falls back to the template model). For a `dedicated` env this is the same row the
		// old per-env lookup returned.
		const [iacSource] = fabric
			? await tx
					.select()
					.from(projectIacSources)
					.where(
						and(
							eq(projectIacSources.project_id, projectId),
							eq(projectIacSources.fabric_id, fabric.id),
							eq(projectIacSources.enabled, true),
						),
					)
					.limit(1)
			: [];

		// Fail-closed KIND gate: reject any present component whose KIND the target cloud's
		// built-in template can't provision (Hetzner: topic/nosql/bucket/registry). Derived from
		// the SAME UNSUPPORTED_KINDS_BY_PROVIDER set the Add-palette hides — a cloud-switch or an
		// AI-composed graph can smuggle a hidden kind past the palette, and the snapshot mapper
		// would then silently drop it (SUCCESS without the component). Skipped in BYO-IaC replace
		// mode (like the placement/network gates below): the customer's module, not the component
		// graph, decides what gets provisioned.
		if (!iacSource) {
			const blocked = new Set<NodeKind>(unsupportedKindsFor(identity.provider));
			if (blocked.size > 0) {
				const present: Array<{ kind: NodeKind; name: string }> = [
					...(network ? [{ kind: "network" as const, name: "network" }] : []),
					...(cluster ? [{ kind: "cluster" as const, name: "cluster" }] : []),
					...(dns?.enabled
						? [{ kind: "dns" as const, name: dns.domain_name ?? "dns" }]
						: []),
					...databases.map((d) => ({
						kind: "database" as const,
						name: d.name,
					})),
					...caches.map((c) => ({ kind: "cache" as const, name: c.name })),
					...queues.map((q) => ({ kind: "queue" as const, name: q.name })),
					...topics.map((t) => ({ kind: "topic" as const, name: t.name })),
					...nosqlTables.map((n) => ({ kind: "nosql" as const, name: n.name })),
					...secrets.map((s) => ({ kind: "secret" as const, name: s.name })),
					...storageBuckets.map((b) => ({
						kind: "bucket" as const,
						name: b.name,
					})),
					...containerRegistries.map((r) => ({
						kind: "registry" as const,
						name: r.name,
					})),
				];
				for (const c of present) {
					if (blocked.has(c.kind)) {
						throw unsupportedKindGateError(c.kind, identity.provider, c.name);
					}
				}
			}

			// W3 fail-closed binding gate: every service binding must reference a backing resource
			// that exists in THIS environment. A dangling {kind,name} would reach the runner and
			// fail to resolve at deploy (no endpoint/secret to inject) — fail loudly here instead of
			// a confusing deploy-time error. Skipped in BYO-IaC replace mode (inside `!iacSource`),
			// where the backing resource may be provisioned by the customer's module, not the graph.
			const dbNames = new Set(databases.map((d) => d.name));
			const cacheNames = new Set(caches.map((c) => c.name));
			const queueNames = new Set(queues.map((q) => q.name));
			const secretNames = new Set(secrets.map((s) => s.name));
			for (const svc of services) {
				for (const b of svc.bindings ?? []) {
					const targetExists =
						b.target.kind === "database"
							? dbNames.has(b.target.name)
							: b.target.kind === "cache"
								? cacheNames.has(b.target.name)
								: b.target.kind === "queue"
									? queueNames.has(b.target.name)
									: secretNames.has(b.target.name);
					if (!targetExists) {
						throw new Error(
							`Service "${svc.name}" binds to ${b.target.kind} "${b.target.name}", which does not exist in this environment. Add the ${b.target.kind} or remove the binding.`,
						);
					}
				}
			}
		}

		// Hetzner is compute-only: canvas database/cache/queue nodes have no managed cloud
		// service, so they deploy as in-cluster Helm charts (CloudNativePG / Valkey / RabbitMQ).
		// Map them to install specs and append — the runner renders each as an ArgoCD
		// Application via the same generic add-on path (packages/core/argocd). The data-component
		// rows still ride the snapshot for the UI; the Hetzner tofu template ignores them.
		if (identity.provider === "hetzner") {
			// Fail-closed engine gate: the mapper only charts what it supports (a NULL
			// engine_family defaults to postgres), so anything else must throw here rather
			// than be dropped from the deploy silently. Caches/queues need no gate — the
			// mapper charts every row (Valkey/RabbitMQ), whatever engine the row carries.
			const supported = new Set<string>(HETZNER_DB_ENGINES);
			for (const db of databases) {
				if (db.engine_family && !supported.has(db.engine_family)) {
					throw hetznerDbEngineGateError(db.name, db.engine_family);
				}
			}
			addons.push(
				...hetznerDataServicesToAddOns({ databases, caches, queues }),
			);
		}

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
					...storageBuckets.map((b) => b.cloud_identity_id),
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
		// Both template-model gates are skipped in BYO-IaC replace mode (see iacSource above):
		// the customer's module, not the component graph, decides what gets provisioned.
		if (!iacSource) {
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
		}

		// B1.1: resolve the effective classification (env overrides project per dimension)
		// into the frozen snapshot so the runner can propagate it to cloud resource tags/labels.
		// RLS scopes both reads to the owner's org (we're inside withOwnerScope).
		const [projectClassification, envClassification] = await Promise.all([
			listAssignmentsFor(tx, "project", projectId),
			listAssignmentsFor(tx, "project_environment", envId),
		]);
		const classification = resolveClassificationSnapshot(
			projectClassification,
			envClassification,
		);

		const configSnapshot = {
			...project,
			// M1: the Go provisioner reads `environment_stage` (frozen wire key) for the
			// tofu state path + the `environment` tfvar — feed it the environment's name.
			environment_stage: environment.name,
			// B1.2: the environment's stable UUID (distinct from the human stage name), emitted
			// by the runner as the `alethia:environment-id` tag so a guarded sweeper can scope
			// destroys to exactly one environment's cloud resources.
			environment_id: environment.id,
			// #837 (decoupled env-model): the Fabric (infra unit) this env is PLACED onto, and how.
			// The #838 provisioner re-keys the per-Fabric tofu state onto `fabric_name` and sets the
			// ArgoCD Application destination from `placement_mode` + `namespace`. For a backfilled
			// `dedicated` env `fabric_name === environment.name`, so the state path stays
			// byte-identical (fabric is null only for not-yet-linked transitional rows → fall back
			// to the env name). `namespace` is null for `dedicated` (owns the whole Fabric).
			fabric_id: fabric?.id ?? null,
			fabric_name: fabric?.name ?? environment.name,
			placement_mode: environment.placement_mode,
			namespace,
			region: environment.region ?? project.region,
			provider: identity.provider,
			// B1.1: frozen per-dimension classification map ({ dimension_key: value_slug[] }),
			// environment overriding project per dimension. See ClassificationSnapshot.
			classification,
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
				// Provisioned cluster name/endpoint (set after the first deploy) — lets a
				// day-2 drift job acquire kubeconfig to inspect add-on health + security.
				cluster_name: cluster?.cluster_name ?? null,
				cluster_endpoint: cluster?.cluster_endpoint ?? null,
				instance_types: cluster?.instance_types ?? [],
				node_min_size: cluster?.node_min_size ?? 2,
				node_max_size: cluster?.node_max_size ?? 5,
				node_desired_size: cluster?.node_desired_size ?? 2,
				node_disk_size_gb: cluster?.node_disk_size_gb ?? null,
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
			// Scanned source repos + detected services — the runner generates app
			// manifests from these into an empty GitOps repo at deploy time.
			source_repos: sourceRepos.map((r) => ({
				repo_url: r.repo_url,
				ref: r.ref ?? undefined,
				scan_path: r.scan_path,
				services: r.services ?? [],
			})),
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
			storage_buckets: storageBuckets.map((b) => ({
				...b,
				...resolvePlacement(b),
			})),
			// W1 — first-class application workloads (the customer's own code). The runner renders
			// each into k8s manifests; image build/push (from source when kind==="repo") is W2.
			services: services.map((s) => ({ ...s, ...resolvePlacement(s) })),
			// Marketplace add-ons (resolved install specs) — the runner renders each as an
			// ArgoCD Helm Application after the cluster + ArgoCD are up.
			addons,
			// Bring-your-own IaC (E3, replace mode): when present, the runner clones this repo at
			// the PINNED commit_sha (never the moving ref — TOCTOU protection) and runs the
			// customer's root module instead of the built-in template. Absent for template envs.
			// A DESTROY job pins the commit that CREATED the live state (deployed_commit_sha), not
			// a newer unpinned re-scan — `tofu destroy` must run the module that actually applied.
			...(iacSource
				? {
						iac_source: {
							repo_url: iacSource.repo_url,
							ref: iacSource.ref ?? undefined,
							path: iacSource.path,
							commit_sha:
								jobKind === "destroy"
									? (iacSource.deployed_commit_sha ?? iacSource.commit_sha)
									: iacSource.commit_sha,
							var_values: iacSource.var_values ?? {},
						},
					}
				: {}),
			// Token is fetched at runtime by the runner via POST /api/jobs/[id]/git-token.
			git_access_token: "",
		};

		return {
			project,
			identity,
			environment,
			configSnapshot,
			iacSource: iacSource ?? null,
		};
	});
}

/**
 * Queue gate for BYO-IaC environments: when an enabled IaC source exists, the job may only
 * queue if the feature flag is on (defense in depth — a row can predate a flag flip). PLAN and
 * DEPLOY additionally require a fresh scan that pinned the commit to apply. DESTROY does NOT —
 * it tears down the live state created by the last successful DEPLOY, so it gates on
 * `deployed_commit_sha` (the commit that CREATED the state) instead: a failed re-scan clears
 * `commit_sha` but must never trap deployed infra. Template envs (no row) pass through untouched.
 */
function assertIacSourceQueueable(
	iacSource: typeof projectIacSources.$inferSelect | null,
	kind: "plan" | "deploy" | "destroy",
): void {
	if (!iacSource) return;
	if (!isByoIacEnabled()) {
		throw new Error(
			"This environment has a bring-your-own IaC source attached, but the feature is disabled " +
				"on this instance — set ALETHIA_BYO_IAC_ENABLED=true, or detach the IaC source.",
		);
	}
	if (kind === "destroy") {
		// Destroy needs the module commit that created the state, not a clean re-scan.
		if (!iacSource.deployed_commit_sha) {
			throw new Error(
				"This environment has no deployed IaC state to destroy — deploy the attached IaC " +
					"source first (destroy tears down the exact commit that was applied).",
			);
		}
		return;
	}
	if (iacSource.scan_status !== "done" || !iacSource.commit_sha) {
		throw new Error(
			"The attached IaC source hasn't passed a scan yet — run the IaC scan first (it pins the " +
				"exact commit that will be applied) before planning or deploying this environment.",
		);
	}
}

/**
 * Resolves a provisioning job's deploy destination in the decoupled env-model (#837): the target
 * environment (the explicitly-passed one, verified to belong to the project, else the project's
 * default), the Fabric (infra unit) it is placed onto, and the effective Kubernetes namespace.
 * `dedicated` placements own their Fabric 1:1 → `namespace = null` (the legacy env=cluster
 * behaviour); `namespace`/`vcluster` placements resolve to the env's explicit `namespace`, else a
 * slug of its name. `fabric` is null only for transitional rows the seam backfill has not linked yet.
 */
async function resolveTargetEnvironment(
	tx: Parameters<Parameters<typeof withActorScope>[1]>[0],
	projectId: string,
	environmentId?: string | null,
): Promise<{
	environment: ProjectEnvironment;
	fabric: ProjectFabric | null;
	namespace: string | null;
}> {
	let environment: ProjectEnvironment | undefined;
	if (environmentId) {
		[environment] = await tx
			.select()
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.id, environmentId),
					eq(projectEnvironments.project_id, projectId),
				),
			)
			.limit(1);
		if (!environment) throw new Error("Environment not found for this project");
	} else {
		[environment] = await tx
			.select()
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.project_id, projectId),
					eq(projectEnvironments.is_default, true),
				),
			)
			.limit(1);
		if (!environment) throw new Error("Project has no default environment");
	}

	// The Fabric (infra unit) this env is placed onto. NULL only for transitional rows the seam
	// backfill has not linked yet — the caller treats that as its own dedicated Fabric (back-compat).
	let fabric: ProjectFabric | null = null;
	if (environment.fabric_id) {
		const [row] = await tx
			.select()
			.from(projectFabrics)
			.where(
				and(
					eq(projectFabrics.id, environment.fabric_id),
					eq(projectFabrics.project_id, projectId),
				),
			)
			.limit(1);
		fabric = row ?? null;
	}

	// Effective ArgoCD destination namespace. `dedicated` owns the whole Fabric → no namespace
	// (legacy behaviour); shared placements use the env's explicit namespace, else an RFC-1123
	// slug of its name (via slugify, capped at 63 chars — the k8s namespace length limit).
	const namespace =
		environment.placement_mode === "dedicated"
			? null
			: (environment.namespace ?? slugify(environment.name, 63));

	return { environment, fabric, namespace };
}

/**
 * Routes an enqueue path's env→QUEUED write through the CAS (lib/db/env-status.ts). Throws — rolling
 * back the enclosing withOwnerScope tx, including the just-inserted job — if the env isn't in a legal
 * from-state, so a synchronous user action never queues an orphan job against an in-flight or
 * torn-down env. (Runner status callbacks, by contrast, never throw on a lost race; see env-status.ts.)
 */
async function enqueueEnvTransition(
	tx: Tx,
	envId: string,
	context: EnvTransitionContext,
	jobId: string,
	meta: { orgId: string; projectId: string },
): Promise<void> {
	const moved = await transitionEnv(tx, envId, context, jobId, meta);
	if (!moved)
		throw new Error(
			"Environment is not in a valid state for this operation — a job may already be in progress.",
		);
}

export async function planProject(
	projectId: string,
	runnerId?: string | null,
	environmentId?: string | null,
) {
	const actor = await authorize("plan", { type: "project", id: projectId });
	// Defense-in-depth: a client-supplied assigned runner must belong to the
	// caller's org (claim_next_job blocks the execution, this blocks the enqueue).
	if (runnerId) await assertRunnerInOrg(getServiceDb(), runnerId, actor.orgId);
	await assertUsageAllowed(actor.orgId);
	await assertJobQuotaAllowed(actor.orgId);
	const owner = actor.userId;
	const { identity, environment, configSnapshot, iacSource } =
		await buildConfigSnapshot(
			owner,
			actor.orgId,
			projectId,
			environmentId,
			"plan",
		);
	assertIacSourceQueueable(iacSource, "plan");

	const result = await withScope(
		{ ownerId: owner, orgId: actor.orgId },
		async (tx) => {
			const [job] = await tx
				.insert(jobs)
				.values(
					signedJob({
						user_id: owner,
						org_id: actor.orgId,
						project_id: projectId,
						environment_id: environment.id,
						cloud_identity_id: identity.id,
						initiated_by: "user",
						job_type: "PLAN",
						config_snapshot: configSnapshot,
						status: "QUEUED",
						// New trace root for this provisioning operation (enqueue → claim → runner).
						traceparent: newTraceparent(),
						...(runnerId ? { assigned_runner_id: runnerId } : {}),
					}),
				)
				.returning({ id: jobs.id });

			await enqueueEnvTransition(tx, environment.id, "enqueuePlan", job.id, {
				orgId: actor.orgId,
				projectId,
			});
			return { jobId: job.id };
		},
	);

	notifyScaler();
	return result;
}

/** True when a frozen config snapshot carries at least one repo-sourced service — a W2
 * build input (the in-cluster kaniko build turns it into a pushed image). */
function hasRepoSourcedServices(configSnapshot: {
	services?: { source?: { kind?: string } | null }[];
}): boolean {
	return (configSnapshot.services ?? []).some(
		(s) => s?.source?.kind === "repo",
	);
}

/**
 * Queue a BUILD job (W2 image build & push): kaniko builds every repo-sourced service's
 * image IN the environment's own cluster and pushes it to the provisioned registry via
 * the build-SA's IRSA (keyless). On SUCCESS the job-status route persists each digest to
 * project_services.resolved_image and chains the app DEPLOY (builds.ts), which renders
 * the services with real images. The build runs in-cluster, so it only queues off an
 * ACTIVE (provisioned) environment.
 */
export async function buildProject(
	projectId: string,
	environmentId?: string | null,
	runnerId?: string | null,
) {
	const actor = await authorize("deploy", { type: "project", id: projectId });
	// Defense-in-depth: a client-supplied assigned runner must belong to the
	// caller's org (claim_next_job blocks the execution, this blocks the enqueue).
	if (runnerId) await assertRunnerInOrg(getServiceDb(), runnerId, actor.orgId);
	await assertUsageAllowed(actor.orgId);
	await assertJobQuotaAllowed(actor.orgId);
	const owner = actor.userId;
	const { identity, environment, configSnapshot } = await buildConfigSnapshot(
		owner,
		actor.orgId,
		projectId,
		environmentId,
		"deploy",
	);

	if (!hasRepoSourcedServices(configSnapshot))
		throw new Error(
			"Nothing to build — this environment has no repo-sourced services.",
		);
	if (environment.status !== "ACTIVE")
		throw new Error(
			"Builds run in the environment's own cluster — provision the infrastructure first.",
		);

	const result = await withScope(
		{ ownerId: owner, orgId: actor.orgId },
		async (tx) => {
			const [job] = await tx
				.insert(jobs)
				.values(
					signedJob({
						user_id: owner,
						org_id: actor.orgId,
						project_id: projectId,
						environment_id: environment.id,
						cloud_identity_id: identity.id,
						initiated_by: "user",
						job_type: "BUILD",
						config_snapshot: configSnapshot,
						status: "QUEUED",
						// New trace root for this build operation (enqueue → claim → runner).
						traceparent: newTraceparent(),
						...(runnerId ? { assigned_runner_id: runnerId } : {}),
					}),
				)
				.returning({ id: jobs.id });

			await enqueueEnvTransition(tx, environment.id, "enqueueDeploy", job.id, {
				orgId: actor.orgId,
				projectId,
			});

			await tx.insert(auditLog).values({
				project_id: projectId,
				user_id: owner,
				action: "PROVISIONED",
				changes: {
					job_id: job.id,
					environment_id: environment.id,
					job_type: "BUILD",
				},
			});

			return { jobId: job.id };
		},
	);

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
	// Defense-in-depth: a client-supplied assigned runner must belong to the
	// caller's org (claim_next_job blocks the execution, this blocks the enqueue).
	if (runnerId) await assertRunnerInOrg(getServiceDb(), runnerId, actor.orgId);
	await assertUsageAllowed(actor.orgId);
	await assertJobQuotaAllowed(actor.orgId);
	const owner = actor.userId;
	const { identity, environment, configSnapshot, iacSource } =
		await buildConfigSnapshot(
			owner,
			actor.orgId,
			projectId,
			environmentId,
			"deploy",
		);
	assertIacSourceQueueable(iacSource, "deploy");

	// W2 build-then-deploy: redeploying an ACTIVE environment that has repo-sourced
	// services queues the BUILD first — the status route persists the digests and chains
	// the DEPLOY (builds.ts), so the deploy renders real images instead of skipping
	// unbuilt services. First-time provisioning (infra not up) deploys infra directly —
	// the in-cluster build has nowhere to run until the cluster exists. A gated
	// plan→apply (planJobId) never reroutes: it must apply exactly the reviewed plan.
	if (
		!planJobId &&
		environment.status === "ACTIVE" &&
		hasRepoSourcedServices(configSnapshot)
	) {
		const result = await withScope(
			{ ownerId: owner, orgId: actor.orgId },
			async (tx) => {
				const [job] = await tx
					.insert(jobs)
					.values(
						signedJob({
							user_id: owner,
							org_id: actor.orgId,
							project_id: projectId,
							environment_id: environment.id,
							cloud_identity_id: identity.id,
							initiated_by: "user",
							job_type: "BUILD",
							config_snapshot: configSnapshot,
							status: "QUEUED",
							traceparent: newTraceparent(),
							...(runnerId ? { assigned_runner_id: runnerId } : {}),
						}),
					)
					.returning({ id: jobs.id });

				await enqueueEnvTransition(
					tx,
					environment.id,
					"enqueueDeploy",
					job.id,
					{
						orgId: actor.orgId,
						projectId,
					},
				);

				await tx.insert(auditLog).values({
					project_id: projectId,
					user_id: owner,
					action: "PROVISIONED",
					changes: {
						job_id: job.id,
						environment_id: environment.id,
						job_type: "BUILD",
					},
				});

				return { jobId: job.id, jobType: "BUILD" as const };
			},
		);

		notifyScaler();
		return result;
	}

	const result = await withScope(
		{ ownerId: owner, orgId: actor.orgId },
		async (tx) => {
			const [job] = await tx
				.insert(jobs)
				.values(
					signedJob({
						user_id: owner,
						org_id: actor.orgId,
						project_id: projectId,
						environment_id: environment.id,
						cloud_identity_id: identity.id,
						initiated_by: "user",
						job_type: "DEPLOY",
						config_snapshot: configSnapshot,
						status: "QUEUED",
						// New trace root for this provisioning operation (enqueue → claim → runner).
						traceparent: newTraceparent(),
						...(planJobId ? { plan_job_id: planJobId } : {}),
						...(runnerId ? { assigned_runner_id: runnerId } : {}),
					}),
				)
				.returning({ id: jobs.id });

			await enqueueEnvTransition(tx, environment.id, "enqueueDeploy", job.id, {
				orgId: actor.orgId,
				projectId,
			});

			await tx.insert(auditLog).values({
				project_id: projectId,
				user_id: owner,
				action: "PROVISIONED",
				changes: { job_id: job.id, environment_id: environment.id },
			});

			return { jobId: job.id };
		},
	);

	notifyScaler();
	return result;
}

/**
 * Queue a DETECT_DRIFT job — the runner runs `tofu plan -refresh-only -json` and
 * `drift.Analyze` on the environment's provisioned state, and posts the posture back
 * (persisted to `environment_drift` by the job-status route). The day-2 "keep proving
 * it" trigger; called manually from the UI/assistant or by a scheduler.
 */
export async function queueDriftDetection(
	projectId: string,
	environmentId?: string | null,
	runnerId?: string | null,
) {
	const actor = await authorize("deploy", { type: "project", id: projectId });
	// Defense-in-depth: a client-supplied assigned runner must belong to the
	// caller's org (claim_next_job blocks the execution, this blocks the enqueue).
	if (runnerId) await assertRunnerInOrg(getServiceDb(), runnerId, actor.orgId);
	await assertJobQuotaAllowed(actor.orgId);
	const owner = actor.userId;
	const { identity, environment, configSnapshot } = await buildConfigSnapshot(
		owner,
		actor.orgId,
		projectId,
		environmentId,
	);

	const result = await withScope(
		{ ownerId: owner, orgId: actor.orgId },
		async (tx) => {
			const [job] = await tx
				.insert(jobs)
				.values(
					signedJob({
						user_id: owner,
						org_id: actor.orgId,
						project_id: projectId,
						environment_id: environment.id,
						cloud_identity_id: identity.id,
						initiated_by: "user",
						job_type: "DETECT_DRIFT",
						config_snapshot: configSnapshot,
						status: "QUEUED",
						// New trace root for this drift-detection operation (enqueue → claim → runner).
						traceparent: newTraceparent(),
						...(runnerId ? { assigned_runner_id: runnerId } : {}),
					}),
				)
				.returning({ id: jobs.id });
			return { jobId: job.id };
		},
	);

	notifyScaler();
	return result;
}

/**
 * Queue a DESTROY job to tear down a project's environment in the cloud — mirrors
 * provisionProject but with job_type DESTROY: the env moves to QUEUED and a runner
 * destroys the provisioned resources. Distinct from deleteProject, which only drops the
 * DB rows. Used by the canvas Pending Changes bar's Destroy action.
 */
export async function destroyProject(
	projectId: string,
	environmentId?: string | null,
	runnerId?: string | null,
) {
	const actor = await authorize("destroy", { type: "project", id: projectId });
	// Defense-in-depth: a client-supplied assigned runner must belong to the
	// caller's org (claim_next_job blocks the execution, this blocks the enqueue).
	if (runnerId) await assertRunnerInOrg(getServiceDb(), runnerId, actor.orgId);
	await assertUsageAllowed(actor.orgId);
	await assertJobQuotaAllowed(actor.orgId);
	const owner = actor.userId;
	const { identity, environment, configSnapshot, iacSource } =
		await buildConfigSnapshot(
			owner,
			actor.orgId,
			projectId,
			environmentId,
			"destroy",
		);
	assertIacSourceQueueable(iacSource, "destroy");

	const result = await withScope(
		{ ownerId: owner, orgId: actor.orgId },
		async (tx) => {
			const [job] = await tx
				.insert(jobs)
				.values(
					signedJob({
						user_id: owner,
						org_id: actor.orgId,
						project_id: projectId,
						environment_id: environment.id,
						cloud_identity_id: identity.id,
						initiated_by: "user",
						job_type: "DESTROY",
						config_snapshot: configSnapshot,
						status: "QUEUED",
						// New trace root for this teardown operation (enqueue → claim → runner).
						traceparent: newTraceparent(),
						...(runnerId ? { assigned_runner_id: runnerId } : {}),
					}),
				)
				.returning({ id: jobs.id });

			await enqueueEnvTransition(tx, environment.id, "enqueueDestroy", job.id, {
				orgId: actor.orgId,
				projectId,
			});

			await tx.insert(auditLog).values({
				project_id: projectId,
				user_id: owner,
				action: "DESTROYED",
				changes: { job_id: job.id, environment_id: environment.id },
			});

			return { jobId: job.id };
		},
	);

	notifyScaler();
	return result;
}

/**
 * Queue a DETECT_DRIFT job (elench): a refresh-only plan that reports drift between
 * recorded state and the live cloud for an environment, storing a drift posture on
 * the job's execution_metadata. Read-only against the cloud — it never applies.
 * A scheduler can call this per environment on a tiered cadence; it's also
 * invocable on demand.
 */
export async function detectDrift(
	projectId: string,
	environmentId?: string | null,
	runnerId?: string | null,
) {
	const actor = await authorize("plan", { type: "project", id: projectId });
	// Defense-in-depth: a client-supplied assigned runner must belong to the
	// caller's org (claim_next_job blocks the execution, this blocks the enqueue).
	if (runnerId) await assertRunnerInOrg(getServiceDb(), runnerId, actor.orgId);
	await assertUsageAllowed(actor.orgId);
	await assertJobQuotaAllowed(actor.orgId);
	const owner = actor.userId;
	const { identity, environment, configSnapshot } = await buildConfigSnapshot(
		owner,
		actor.orgId,
		projectId,
		environmentId,
	);

	const result = await withScope(
		{ ownerId: owner, orgId: actor.orgId },
		async (tx) => {
			const [job] = await tx
				.insert(jobs)
				.values(
					signedJob({
						user_id: owner,
						org_id: actor.orgId,
						project_id: projectId,
						environment_id: environment.id,
						cloud_identity_id: identity.id,
						initiated_by: "user",
						job_type: "DETECT_DRIFT",
						config_snapshot: configSnapshot,
						status: "QUEUED",
						// New trace root for this drift-detection operation (enqueue → claim → runner).
						traceparent: newTraceparent(),
						...(runnerId ? { assigned_runner_id: runnerId } : {}),
					}),
				)
				.returning({ id: jobs.id });
			return { jobId: job.id };
		},
	);

	notifyScaler();
	return result;
}

// ============================================================
// Delete
// ============================================================

// Environment states that mean live (or in-flight) cloud infrastructure — a project can't be
// deleted from under them; the environments must be destroyed first.
const LIVE_ENV_STATUSES = new Set([
	"QUEUED",
	"PROVISIONING",
	"ACTIVE",
	"DESTROYING",
]);

/**
 * Permanently deletes a project record. Child rows (environments, components, promotions, drift)
 * cascade; jobs keep their history with a null project reference. This does NOT tear down
 * provisioned cloud infrastructure — it refuses while any environment is live/in-flight, so the
 * caller must destroy those environments first.
 */
export async function deleteProject(projectId: string) {
	const actor = await authorize("destroy", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		// Refuse while any environment is live/in-flight — deleting would orphan cloud resources.
		const envs = await tx
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId));
		if (envs.some((e) => LIVE_ENV_STATUSES.has(e.status))) {
			throw new Error(
				"This project has live or in-flight environments. Destroy them before deleting the project.",
			);
		}
		// CASCADE handles all component tables.
		await tx.delete(projects).where(eq(projects.id, projectId));
		return { success: true };
	});
}

// ============================================================
// Duplicate for another provider
// ============================================================

// `projectServices.type` and the env's `environment_stage` source are now pgEnum-backed (see
// schema/enums.ts), so getProject returns them already narrowed — the #580 narrowing helpers are gone.

/** Converts a project's DB representation to ProjectFormData for duplication / pre-populating forms. */
export async function getProjectAsFormData(
	projectId: string,
	environmentId?: string | null,
): Promise<{ formData: ProjectFormData; provider: CloudProviderSlug }> {
	const source = await getProject(projectId, environmentId);

	let provider: CloudProviderSlug = "aws";
	if (source.project.cloud_identity_id) {
		const actor = await currentActor();
		const ci = await withActorScope(actor, async (tx) => {
			const [row] = await tx
				.select({ provider: cloudIdentities.provider })
				.from(cloudIdentities)
				.where(eq(cloudIdentities.id, source.project.cloud_identity_id!))
				.limit(1);
			return row;
		});
		if (!ci) throw new Error("Cloud identity not found");
		provider = asCloudProviderSlug(ci.provider);
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
					cluster_version:
						source.components.cluster.cluster_version ??
						DEFAULT_K8S_VERSION[provider],
					instance_types: source.components.cluster.instance_types ?? [],
					node_min_size: source.components.cluster.node_min_size ?? 2,
					node_max_size: source.components.cluster.node_max_size ?? 5,
					node_desired_size: source.components.cluster.node_desired_size ?? 2,
					node_disk_size_gb:
						source.components.cluster.node_disk_size_gb ?? undefined,
					cluster_admins: source.components.cluster.cluster_admins ?? [],
					provider_config: source.components.cluster.provider_config ?? {},
				}
			: {
					cluster_version: DEFAULT_K8S_VERSION[provider],
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
		source_repos: source.components.source_repos.map((r) => ({
			repo_url: r.repo_url,
			ref: r.ref ?? undefined,
			scan_path: r.scan_path,
			services: r.services ?? [],
		})),
		databases: source.components.databases.map((db) => ({
			name: db.name,
			engine: db.engine ?? undefined,
			engine_version: db.engine_version ?? undefined,
			instance_class: db.instance_class ?? undefined,
			min_capacity: db.min_capacity ?? undefined,
			max_capacity: db.max_capacity ?? undefined,
			port: db.port ?? undefined,
			backup_retention_days: db.backup_retention_days ?? undefined,
			iam_auth: db.iam_auth ?? undefined,
		})),
		caches: source.components.caches.map((c) => ({
			name: c.name,
			engine: c.engine ?? undefined,
			engine_version: c.engine_version ?? undefined,
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
		storage_buckets: source.components.storage_buckets.map((b) => ({
			name: b.name,
			versioning: b.versioning ?? undefined,
			encryption_enabled: b.encryption_enabled ?? undefined,
			public_access: b.public_access ?? undefined,
			cors_origins: b.cors_origins ?? undefined,
			provider_config: b.provider_config ?? undefined,
		})),
		// Output columns (repository_url) are provisioned state, not design — stripped here.
		container_registries: source.components.container_registries.map((r) => ({
			name: r.name,
			provider: r.provider ?? undefined,
			provider_config: r.provider_config ?? undefined,
		})),
		// Output columns (resolved_image) are provisioned state, not design — stripped here.
		// Bindings (W3) ARE design — the user's declared service→infra edges — so they round-trip.
		services: source.components.services.map((s) => ({
			name: s.name,
			type: s.type,
			source: s.source,
			build: s.build ?? undefined,
			env: s.env,
			bindings: s.bindings,
			ports: s.ports,
			replicas: s.replicas,
			resources: s.resources ?? undefined,
			probe: s.probe ?? undefined,
		})),
	};

	return { formData, provider };
}

/** Duplicates a project config for a different cloud provider, mapping provider-specific values. */
export async function duplicateProjectForProvider(
	sourceProjectId: string,
	targetCloudIdentityId: string,
	targetRegion: string,
): Promise<{
	newProjectId: string;
	/** Slug of the new project, for navigating into its canvas (`/{org}/{slug}`). */
	newProjectSlug: string;
	warnings: ConversionWarning[];
}> {
	const actor = await authorize("create", { type: "project" });
	const owner = actor.userId;

	const { formData, provider: sourceProvider } =
		await getProjectAsFormData(sourceProjectId);

	const targetIdentity = await withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, targetCloudIdentityId))
			.limit(1);
		return row;
	});

	if (!targetIdentity) throw new Error("Target cloud identity not found");

	const targetProvider = asCloudProviderSlug(targetIdentity.provider);

	const { data: converted, warnings } = convertProjectConfig(
		formData,
		sourceProvider,
		targetProvider,
	);

	converted.project.region = targetRegion;
	converted.project.cloud_identity_id = targetCloudIdentityId;

	const { project } = await createProject(converted);
	if (!project.slug) throw new Error("Duplicated project is missing a slug");

	return {
		newProjectId: project.id,
		newProjectSlug: project.slug,
		warnings,
	};
}

/**
 * The infrastructure categories a project's default environment currently provisions — used by the
 * cross-cloud duplicate dialog to preview which managed services will be translated (cluster → GKE,
 * Aurora → Cloud SQL, …). `network` + `cluster` are always present; the rest are listed only when
 * the design actually has one. Purely a read of the design (no provisioned state).
 */
export type DuplicateCategory =
	| "network"
	| "cluster"
	| "dns"
	| "databases"
	| "caches"
	| "nosql"
	| "queues"
	| "topics"
	| "secrets";

/** Source provider + the service categories present, for the cross-cloud duplicate preview. */
export async function getProjectDuplicateSummary(projectId: string): Promise<{
	provider: CloudProviderSlug;
	projectName: string;
	categories: DuplicateCategory[];
}> {
	const { formData, provider } = await getProjectAsFormData(projectId);
	const categories: DuplicateCategory[] = ["network", "cluster"];
	if (formData.dns?.enabled) categories.push("dns");
	if (formData.databases?.length) categories.push("databases");
	if (formData.caches?.length) categories.push("caches");
	if (formData.nosql_tables?.length) categories.push("nosql");
	if (formData.queues?.length) categories.push("queues");
	if (formData.topics?.length) categories.push("topics");
	if (formData.secrets?.length) categories.push("secrets");
	return { provider, projectName: formData.project.project_name, categories };
}

// ============================================================
// Environments (M1) — a project owns N independently-provisionable environments.
// ============================================================

/** Lists a project's environments (default first, then by creation). */
export async function getProjectEnvironments(projectId: string) {
	const actor = await authorize("view", { type: "project", id: projectId });
	const owner = actor.userId;
	return withActorScope(actor, async (tx) => {
		const environments = await tx
			.select()
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId))
			.orderBy(
				desc(projectEnvironments.is_default),
				projectEnvironments.created_at,
			);
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
	const name = slugify(input.name);
	if (!name) throw new Error("Environment name is required");
	if (RESERVED_PROJECT_CHILD_SLUGS.includes(name))
		throw new Error(
			`"${name}" is reserved and can't be used as an environment name`,
		);
	return withActorScope(actor, async (tx) => {
		const [project] = await tx
			.select({ org_id: projects.org_id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!project) notFound(); // stale/deleted id → 404, not a captured error
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

/**
 * Creates a new environment by duplicating an existing one: it inherits the base environment's
 * stage + region AND a fresh copy of all the base env's components (services/variables/config).
 * The copy is config-only — `getProjectAsFormData` strips provisioned outputs, and the new rows
 * start `status:"PENDING"` — so the duplicate is undeployed until its own Deploy.
 */
export async function duplicateEnvironment(
	projectId: string,
	baseEnvironmentId: string,
	name: string,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const owner = actor.userId;
	const slug = slugify(name);
	if (!slug) throw new Error("Environment name is required");
	if (RESERVED_PROJECT_CHILD_SLUGS.includes(slug))
		throw new Error(
			`"${slug}" is reserved and can't be used as an environment name`,
		);
	// The base env's design (form shape = config only; provisioned outputs already stripped). Null
	// when the base env has no design yet (an empty env) → the duplicate is created empty too.
	const baseConfig = await getProjectAsFormData(projectId, baseEnvironmentId)
		.then((r) => r.formData)
		.catch(() => null);
	return withActorScope(actor, async (tx) => {
		const [base] = await tx
			.select({
				org_id: projectEnvironments.org_id,
				stage: projectEnvironments.stage,
				region: projectEnvironments.region,
			})
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.id, baseEnvironmentId),
					eq(projectEnvironments.project_id, projectId),
				),
			)
			.limit(1);
		if (!base) throw new Error("Base environment not found for this project");
		const [env] = await tx
			.insert(projectEnvironments)
			.values({
				project_id: projectId,
				user_id: owner,
				org_id: base.org_id,
				name: slug,
				stage: base.stage,
				status: "DRAFT",
				is_default: false,
				region: base.region,
			})
			.returning();
		if (!env) throw new Error("Failed to create environment");
		// Copy the base env's components into the new env (fresh rows, status defaults to PENDING).
		if (baseConfig) await writeComponents(tx, projectId, env.id, baseConfig);
		return { environment: env };
	});
}

/** Toggles opt-in auto-heal for an environment (reconcile re-applies the deployed design on drift). */
export async function setAutoHeal(
	projectId: string,
	environmentId: string,
	enabled: boolean,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	return withActorScope(actor, (tx) =>
		tx
			.update(projectEnvironments)
			.set({ auto_heal: enabled, updated_at: new Date() })
			.where(
				and(
					eq(projectEnvironments.id, environmentId),
					eq(projectEnvironments.project_id, projectId),
				),
			),
	);
}

/** Per-component presence across a project's environments (the "where do my envs diverge" matrix). */
export interface EnvConsistency {
	envs: { id: string; name: string; stage: string }[];
	rows: {
		component_type: string;
		key: string;
		/** Per env id: `present` (aligned), `differs` (structural mismatch vs peers), or `absent`. */
		perEnv: Record<string, "present" | "differs" | "absent">;
	}[];
}

/**
 * Builds the cross-environment consistency matrix: each promotable component (keyed by type + name)
 * marked per environment as present / differs / absent. `differs` = the component exists in more than
 * one env with a diverging *structural* signature (from `designInventory`).
 */
export async function getEnvConsistency(
	projectId: string,
): Promise<EnvConsistency> {
	await authorize("view", { type: "project", id: projectId });
	const { environments } = await getProjectEnvironments(projectId);
	const designs = await Promise.all(
		environments.map(async (e) => {
			// Reading an env's design can throw (e.g. a since-deleted cloud identity). Degrade that
			// env to an empty inventory (its components read as "absent") instead of failing the
			// whole consistency matrix — the environments list must always render.
			try {
				return {
					env: e,
					inventory: designInventory(
						(await getProjectAsFormData(projectId, e.id)).formData,
					),
				};
			} catch {
				return { env: e, inventory: [] };
			}
		}),
	);

	// composite key ("typename") → { present sigs per env }
	const keys = new Map<string, { component_type: string; key: string }>();
	const sigByEnv = new Map<string, Map<string, string>>(); // envId → (compositeKey → sig)
	for (const { env, inventory } of designs) {
		const m = new Map<string, string>();
		for (const entry of inventory) {
			const composite = `${entry.component_type}${entry.key}`;
			keys.set(composite, {
				component_type: entry.component_type,
				key: entry.key,
			});
			m.set(composite, entry.sig);
		}
		sigByEnv.set(env.id, m);
	}

	const rows = Array.from(keys.entries())
		.map(([composite, meta]) => {
			const presentSigs = new Set<string>();
			for (const m of sigByEnv.values()) {
				const s = m.get(composite);
				if (s !== undefined) presentSigs.add(s);
			}
			const diverges = presentSigs.size > 1;
			const perEnv: Record<string, "present" | "differs" | "absent"> = {};
			for (const env of environments) {
				const has = sigByEnv.get(env.id)?.has(composite);
				perEnv[env.id] = has ? (diverges ? "differs" : "present") : "absent";
			}
			return { component_type: meta.component_type, key: meta.key, perEnv };
		})
		.sort((a, b) =>
			`${a.component_type}${a.key}`.localeCompare(
				`${b.component_type}${b.key}`,
			),
		);

	return {
		envs: environments.map((e) => ({ id: e.id, name: e.name, stage: e.stage })),
		rows,
	};
}

/** Deletes a non-default environment (the default is the project's anchor). */
export async function deleteEnvironment(
	projectId: string,
	environmentId: string,
) {
	const actor = await authorize("edit", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
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
		await tx
			.delete(projectEnvironments)
			.where(eq(projectEnvironments.id, environmentId));
		return { success: true };
	});
}

// ============================================================
// Project settings — General tab.
// ============================================================

/** The editable general fields for a project (project → Settings → General). */
export async function getProjectGeneral(
	projectId: string,
): Promise<{ id: string; project_name: string; slug: string | null }> {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({
				id: projects.id,
				project_name: projects.project_name,
				slug: projects.slug,
			})
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!row) notFound(); // render loader: stale/deleted id → 404, not a captured error
		return row;
	});
}

/**
 * Renames a project. The slug is intentionally left stable so existing URLs / bookmarks keep
 * resolving — only the display name changes.
 */
export async function updateProjectName(
	projectId: string,
	name: string,
): Promise<{ project_name: string }> {
	const actor = await authorize("edit", { type: "project", id: projectId });
	const project_name = name.trim();
	if (!project_name) throw new Error("A project name is required");
	if (project_name.length > 100)
		throw new Error("Project name must be 100 characters or fewer");
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.update(projects)
			.set({ project_name, updated_at: new Date() })
			.where(eq(projects.id, projectId))
			.returning({ project_name: projects.project_name });
		if (!row) notFound(); // stale/deleted id → 404, not a captured error
		return row;
	});
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
	return withActorScope(actor, async (tx) => {
		const rows = await tx
			.select(projectSelect())
			.from(projects)
			.leftJoin(
				cloudIdentities,
				eq(projects.cloud_identity_id, cloudIdentities.id),
			)
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

// ============================================================
// Faceted project list — server-side search / filter / sort for the org overview grid.
// ============================================================

/** A source repo attached to a project, with a short `owner/repo` display label. */
export interface ProjectRepoRef {
	url: string;
	label: string;
}

/** A project list row enriched with its distinct source repositories (for the repo facet) plus the
 * default-environment rollup the overview card reads: configured services / add-ons, environment
 * count, and last-deploy time. */
export type ProjectListItem = ProjectWithProvider & {
	repositories: ProjectRepoRef[];
	/** Configured services in the default environment. */
	services_count: number;
	/** Installed add-ons in the default environment. */
	addons_count: number;
	/** Total environments on the project (default + others). */
	environments_count: number;
	/** When the default environment was last deployed (null = never provisioned). */
	last_deployed_at: Date | null;
};

/** Server-side query for the overview grid. All fields optional; empty = no filter. */
export interface ProjectListQuery {
	/** Case-insensitive substring match on the project name. */
	q?: string;
	/** Keep projects whose cloud provider is in this set (OR). */
	clouds?: string[];
	/** Keep projects that use any of these source-repo URLs (OR). */
	repos?: string[];
	/** `activity` = default-env `updated_at` desc (default); `name` = A→Z. */
	sort?: "activity" | "name";
}

/** A cloud facet option with its count over the unfiltered org universe. */
export interface CloudFacet {
	value: string;
	count: number;
}

/** A repository facet option (url + display label) with its unfiltered count. */
export interface RepoFacet extends ProjectRepoRef {
	count: number;
}

/** The filtered/sorted grid rows plus the full (unfiltered) facet universe — with counts
 * so the filter bar's options show how many projects each matches (the console filter
 * standard: counts over the universe, options never disappear as you select them). */
export interface ProjectListResult {
	projects: ProjectListItem[];
	facets: { clouds: CloudFacet[]; repos: RepoFacet[] };
}

/**
 * The org's projects for the overview grid, searched/filtered/sorted server-side. Returns the
 * matching rows plus `facets` (every cloud + repository across the org, regardless of the active
 * filter) so the filter popover always lists the full set of options. Favorites-first ordering is
 * applied client-side (favorites live in the browser), so this only sorts by activity or name.
 */
export async function queryProjects(
	query: ProjectListQuery = {},
): Promise<ProjectListResult> {
	const actor = await authorize("view", { type: "project" });
	return withActorScope(actor, async (tx) => {
		const rows = await tx
			.select(projectSelect())
			.from(projects)
			.leftJoin(
				cloudIdentities,
				eq(projects.cloud_identity_id, cloudIdentities.id),
			)
			.leftJoin(
				projectEnvironments,
				and(
					eq(projectEnvironments.project_id, projects.id),
					eq(projectEnvironments.is_default, true),
				),
			)
			.orderBy(desc(projects.created_at));
		const base = rows.map(toProject);

		// Attach each project's distinct source repos (a project may aggregate several, and the
		// same repo can recur across environments / scan paths — dedupe by URL).
		const ids = base.map((p) => p.id);
		const repoRows = ids.length
			? await tx
					.selectDistinct({
						project_id: projectSourceRepos.project_id,
						repo_url: projectSourceRepos.repo_url,
					})
					.from(projectSourceRepos)
					.where(inArray(projectSourceRepos.project_id, ids))
			: [];
		const repoMap = new Map<string, ProjectRepoRef[]>();
		for (const r of repoRows) {
			if (!r.project_id) continue;
			const list = repoMap.get(r.project_id) ?? [];
			list.push({ url: r.repo_url, label: repoLabel(r.repo_url) });
			repoMap.set(r.project_id, list);
		}
		// Default-environment rollup for the card: environment count + last-deploy time (all envs),
		// and the configured services / installed add-ons of the DEFAULT env only. All counted in
		// memory (mirrors the repo attach above) — the project set is already fully loaded.
		const defaultEnvIds = base
			.map((p) => p.default_environment_id)
			.filter((id): id is string => Boolean(id));

		const envRows = ids.length
			? await tx
					.select({
						project_id: projectEnvironments.project_id,
						last_deployed_at: projectEnvironments.last_deployed_at,
					})
					.from(projectEnvironments)
					.where(inArray(projectEnvironments.project_id, ids))
			: [];
		const envCount = new Map<string, number>();
		const lastDeployed = new Map<string, Date>();
		for (const r of envRows) {
			if (!r.project_id) continue;
			envCount.set(r.project_id, (envCount.get(r.project_id) ?? 0) + 1);
			if (r.last_deployed_at) {
				const cur = lastDeployed.get(r.project_id);
				if (!cur || r.last_deployed_at > cur)
					lastDeployed.set(r.project_id, r.last_deployed_at);
			}
		}

		const serviceRows = defaultEnvIds.length
			? await tx
					.select({ project_id: projectServices.project_id })
					.from(projectServices)
					.where(inArray(projectServices.environment_id, defaultEnvIds))
			: [];
		const serviceCount = new Map<string, number>();
		for (const r of serviceRows) {
			if (!r.project_id) continue;
			serviceCount.set(r.project_id, (serviceCount.get(r.project_id) ?? 0) + 1);
		}

		const addonRows = defaultEnvIds.length
			? await tx
					.select({ project_id: projectAddons.project_id })
					.from(projectAddons)
					.where(inArray(projectAddons.environment_id, defaultEnvIds))
			: [];
		const addonCount = new Map<string, number>();
		for (const r of addonRows) {
			if (!r.project_id) continue;
			addonCount.set(r.project_id, (addonCount.get(r.project_id) ?? 0) + 1);
		}

		const items: ProjectListItem[] = base.map((p) => ({
			...p,
			repositories: repoMap.get(p.id) ?? [],
			services_count: serviceCount.get(p.id) ?? 0,
			addons_count: addonCount.get(p.id) ?? 0,
			environments_count: envCount.get(p.id) ?? 0,
			last_deployed_at: lastDeployed.get(p.id) ?? null,
		}));

		// Facets: the full universe of clouds + repos across the org (never narrowed by
		// filters), each with the count of projects it matches. A project's repositories are
		// already distinct by URL, so one increment per (project, repo) = projects-per-repo.
		const cloudCount = new Map<string, number>();
		const repoFacet = new Map<string, RepoFacet>();
		for (const p of items) {
			if (p.cloud_provider)
				cloudCount.set(
					p.cloud_provider,
					(cloudCount.get(p.cloud_provider) ?? 0) + 1,
				);
			for (const r of p.repositories) {
				const cur = repoFacet.get(r.url);
				if (cur) cur.count += 1;
				else repoFacet.set(r.url, { ...r, count: 1 });
			}
		}
		const facets = {
			clouds: [...cloudCount.entries()]
				.map(([value, count]) => ({ value, count }))
				.sort((a, b) => a.value.localeCompare(b.value)),
			repos: [...repoFacet.values()].sort((a, b) =>
				a.label.localeCompare(b.label),
			),
		};

		// Filter.
		const q = query.q?.trim().toLowerCase();
		const clouds = query.clouds?.length ? new Set(query.clouds) : null;
		const repos = query.repos?.length ? new Set(query.repos) : null;
		const filtered = items.filter((p) => {
			if (q && !p.project_name.toLowerCase().includes(q)) return false;
			if (clouds && !(p.cloud_provider && clouds.has(p.cloud_provider)))
				return false;
			if (repos && !p.repositories.some((r) => repos.has(r.url))) return false;
			return true;
		});

		// Sort (favorites float client-side atop this order).
		filtered.sort((a, b) =>
			query.sort === "name"
				? a.project_name.localeCompare(b.project_name)
				: new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
		);

		return { projects: filtered, facets };
	});
}
