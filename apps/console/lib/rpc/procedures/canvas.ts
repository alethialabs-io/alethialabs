// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// THE CANVAS DOMAIN'S READS (ADR 0005 D1, #6119). Everything the project's Architecture board reads
// lives here as a plain server function, served over GET by the procedures at the bottom and
// prefetched in-process by the Architecture page so the board's first paint carries it.
//
// The bodies MOVED here from the `"use server"` modules that used to serve them as actions:
//   · readEnvironmentStatus      ← app/server/actions/component-status.ts (deleted)
//   · readProjectAddons          ← app/server/actions/addons.ts getProjectAddons
//   · readProjectByoCharts       ← app/server/actions/byo-charts.ts getProjectByoCharts
//   · readProjectChartWorkloads  ← app/server/actions/byo-charts.ts getProjectChartWorkloads
//   · readEnvironmentJobs        ← app/server/actions/canvas-jobs.ts getEnvironmentJobs
//   · readIdentityCapabilities   ← app/server/actions/capabilities.ts (deleted)
//   · readDestroyTree            ← app/server/actions/projects.ts getDestroyTree (deleted; the CLI's
//                                  destroy-tree route reads it from here too)
// Their authorization is unchanged: each still asks the PDP first and then bounds its rows by the
// actor's org (or runs under RLS). The actor is the one the read router bound for the request's
// ADDRESS (`lib/rpc/base.ts`), never the session's org.
//
// Two reads are served without moving: `cloudInventory` calls `getCloudIdentityInventory`
// (app/server/actions/cloud-resources.ts, now a plain server module — the assistant's read tool
// shares it), and `iacSource` calls `getIacSource` in-process (app/server/actions/byo-iac.ts belongs
// to another unit's scope).

import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import type {
	AddonInstallState,
	AddonMarketItem,
	ProjectAddonsView,
} from "@/app/server/actions/addons";
import type { ByoChartState, ChartWorkloadState } from "@/app/server/actions/byo-charts";
import { getIacSource } from "@/app/server/actions/byo-iac";
import type { EnvironmentJobsPage } from "@/app/server/actions/canvas-jobs";
import { getCloudIdentityInventory } from "@/app/server/actions/cloud-resources";
import { getLatestEnvironmentCost } from "@/app/server/actions/cost";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type {
	CapabilityAxis,
	CapabilityBag,
} from "@/components/design-project/canvas/inspector/config-schema";
import { ActionRefusal } from "@/lib/actions/result";
import { NO_DEFAULT_ENVIRONMENT } from "@/lib/canvas/write-refusals";
import { ADDON_CATALOG } from "@/lib/addons/catalog";
import { redactAddonSecrets } from "@/lib/addons/secrets";
import { authorize } from "@/lib/authz/guard";
import {
	EMPTY_ENVIRONMENT_STATUS,
	externalStatusKey,
	type ComponentServerStatus,
	type EnvironmentStatus,
	type IacEnvironment,
} from "@/lib/canvas/component-status";
import { attributeDrift, kindForResourceType, type DriftTarget } from "@/lib/canvas/drift-map";
import { buildIacInventory, parsePlanInventory } from "@/lib/canvas/iac-inventory";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	buildDestroyTree,
	type DestroyTreeNode,
	readLiveFabricTenants,
} from "@/lib/queries/destroy-tree";
import { serviceBindingsByOwner } from "@/lib/db/normalized-reads";
import {
	cloudIdentities,
	environmentDrift,
	environmentProbes,
	jobs,
	projectAddons,
	projectCaches,
	projectChartWorkloads,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectHelmRegistries,
	projectIacSources,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectServices,
	projectStorageBuckets,
	projectTopics,
	projects,
} from "@/lib/db/schema";
import type { ComponentStatus } from "@/lib/db/schema/enums";
import { readGitopsDeployStatus } from "@/lib/gitops/deploy-status";
import { structuralHash } from "@/lib/promotions/diff";
import {
	getCacheTierCapabilities,
	getCacheVersionCapabilities,
	getDatabaseCapabilities,
	getDbInstanceClassCapabilities,
	getInstanceTypeCapabilities,
	getK8sVersionCapabilities,
	getNosqlCapability,
	getRegionCapabilities,
} from "@/lib/queries/capabilities";
import { query } from "@/lib/rpc/base";
import type { DriftDetail } from "@/types/jsonb.types";


/**
 * The active environment of a project, as `resolveActiveEnvironmentId` resolves it — but a project
 * whose environment does not resolve for this actor (another org's project, a deleted environment)
 * is a typed NOT_FOUND (`lib/rpc/base.ts`), not an internal error. Any other failure is rethrown.
 */
export async function resolveEnvironment(
	projectId: string,
	environmentId: string | null | undefined,
): Promise<string> {
	try {
		return await resolveActiveEnvironmentId(projectId, environmentId);
	} catch (error) {
		if (error instanceof Error && error.message === NO_DEFAULT_ENVIRONMENT) {
			throw new ActionRefusal("not-found", "Environment not found.");
		}
		throw error;
	}
}

// ── Environment status: the board's one round-trip of server truth ─────────────────────────────
//
// The server half of canvas node status (W3). Every state below already existed in the database:
// component_status on each project_* table, the env's in-flight job, environment_drift,
// environment_probes. This is the single round-trip that brings them to the canvas, keyed by
// nodeStatusKey() — the join key the canvas was designed around from the start.

/** A component row reduced to what status needs. `name` is absent for singleton kinds. */
type StatusRow = {
	status: ComponentStatus;
	status_message: string | null;
	name?: string;
	/** Output columns written by the deploy finalizer (endpoint / argocd_url / …). */
	outputs?: Record<string, string | null | undefined>;
};

/** Singleton component tables — one row per environment, keyed in the canvas by kind alone. */
const SINGLETON_TABLES = [
	["network", projectNetwork],
	["cluster", projectCluster],
	["dns", projectDns],
] as const;

/** Array component tables — many rows per environment, keyed by `kind:name`. */
const ARRAY_TABLES = [
	["database", projectDatabases],
	["cache", projectCaches],
	["queue", projectQueues],
	["topic", projectTopics],
	["nosql", projectNosqlTables],
	["secret", projectSecrets],
	["bucket", projectStorageBuckets],
	["registry", projectContainerRegistries],
	["helm_registry", projectHelmRegistries],
	["service", projectServices],
] as const;

/** A job the env is still working through. */
const IN_FLIGHT = ["QUEUED", "CLAIMED", "PROCESSING"] as const;

/**
 * Live server status for every component in one environment, plus the env-wide facts the canvas
 * needs to resolve a node's state (the in-flight job, whether the design has moved ahead of what's
 * deployed, cluster liveness, and any drift we couldn't attribute).
 *
 * PDP-gated (`view`). The component/drift/probe tables are RLS-less project children, so — exactly
 * as in `getLatestDriftPosture` — the org boundary is enforced HERE by joining to the parent project
 * and filtering on the caller's org. The service db bypasses RLS, so that predicate IS the tenancy
 * wall: a foreign project UUID returns nothing even though the org-wide PDP grant let `authorize()`
 * through.
 */
export async function readEnvironmentStatus(
	projectId: string,
	environmentId?: string | null,
): Promise<EnvironmentStatus> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const db = getServiceDb();

	// An absent/unresolvable id falls back to the project's default environment — the same rule the
	// Architecture page itself uses, so the canvas and its status can never disagree about WHICH
	// environment they're describing.
	const resolvedEnvId = await resolveActiveEnvironmentId(
		projectId,
		environmentId ?? undefined,
	).catch(() => null);
	if (!resolvedEnvId) return EMPTY_ENVIRONMENT_STATUS;

	// The tenancy wall: this environment must belong to a project in the caller's org.
	const [env] = await db
		.select({
			id: projectEnvironments.id,
			name: projectEnvironments.name,
			stage: projectEnvironments.stage,
			status: projectEnvironments.status,
			deployed_config_hash: projectEnvironments.deployed_config_hash,
		})
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.where(
			and(
				eq(projectEnvironments.id, resolvedEnvId),
				eq(projectEnvironments.project_id, projectId),
				eq(projects.org_id, actor.orgId),
			),
		)
		.limit(1);
	if (!env) return EMPTY_ENVIRONMENT_STATUS;
	const envId = env.id;

	const components: Record<string, ComponentServerStatus> = {};
	const targets: DriftTarget[] = [];

	// Singletons — keyed by kind (nodeStatusKey's singleton branch).
	await Promise.all(
		SINGLETON_TABLES.map(async ([kind, table]) => {
			const [row] = await db
				.select({ status: table.status, status_message: table.status_message })
				.from(table)
				.where(
					and(eq(table.project_id, projectId), eq(table.environment_id, envId)),
				)
				.limit(1);
			if (!row) return;
			addComponent(components, targets, kind, row);
		}),
	);

	// Array kinds — keyed by `kind:name`, matching the component tables' (project, env, name)
	// uniqueness.
	await Promise.all(
		ARRAY_TABLES.map(async ([kind, table]) => {
			const rows = await db
				.select({
					name: table.name,
					status: table.status,
					status_message: table.status_message,
				})
				.from(table)
				.where(
					and(eq(table.project_id, projectId), eq(table.environment_id, envId)),
				);
			for (const row of rows) addComponent(components, targets, kind, row);
		}),
	);

	// The deploy's OUTPUTS — the connection details the finalizer writes and the product never
	// showed. Fetched per-table because the column names differ (a cluster has an endpoint and an
	// ArgoCD URL; a database has a writer and a reader).
	const [clusterOut, dbOut, cacheOut, registryOut] = await Promise.all([
		db
			.select({
				cluster_endpoint: projectCluster.cluster_endpoint,
				argocd_url: projectCluster.argocd_url,
			})
			.from(projectCluster)
			.where(
				and(
					eq(projectCluster.project_id, projectId),
					eq(projectCluster.environment_id, envId),
				),
			)
			.limit(1)
			.then((r) => r[0]),
		db
			.select({
				name: projectDatabases.name,
				endpoint: projectDatabases.endpoint,
				reader_endpoint: projectDatabases.reader_endpoint,
			})
			.from(projectDatabases)
			.where(
				and(
					eq(projectDatabases.project_id, projectId),
					eq(projectDatabases.environment_id, envId),
				),
			),
		db
			.select({
				name: projectCaches.name,
				endpoint: projectCaches.endpoint,
				reader_endpoint: projectCaches.reader_endpoint,
			})
			.from(projectCaches)
			.where(
				and(
					eq(projectCaches.project_id, projectId),
					eq(projectCaches.environment_id, envId),
				),
			),
		db
			.select({
				name: projectContainerRegistries.name,
				repository_url: projectContainerRegistries.repository_url,
			})
			.from(projectContainerRegistries)
			.where(
				and(
					eq(projectContainerRegistries.project_id, projectId),
					eq(projectContainerRegistries.environment_id, envId),
				),
			),
	]);

	setOutputs(components, "cluster", [
		["API endpoint", clusterOut?.cluster_endpoint],
		["ArgoCD", clusterOut?.argocd_url],
	]);
	for (const row of dbOut) {
		setOutputs(components, `database:${row.name}`, [
			["Writer", row.endpoint],
			["Reader", row.reader_endpoint],
		]);
	}
	for (const row of cacheOut) {
		setOutputs(components, `cache:${row.name}`, [
			["Endpoint", row.endpoint],
			["Reader", row.reader_endpoint],
		]);
	}
	for (const row of registryOut) {
		setOutputs(components, `registry:${row.name}`, [["Repository", row.repository_url]]);
	}

	const [activeJobRow, recentJobRows, driftRow, probeRow] = await Promise.all([
		db
			.select({ id: jobs.id, job_type: jobs.job_type, status: jobs.status })
			.from(jobs)
			.where(
				and(
					eq(jobs.project_id, projectId),
					eq(jobs.environment_id, envId),
					eq(jobs.org_id, actor.orgId),
					inArray(jobs.status, [...IN_FLIGHT]),
				),
			)
			.orderBy(desc(jobs.created_at))
			.limit(1)
			.then((r) => r[0]),
		// Recent history (any status) — the Activity tab + Overview recent-activity read this.
		db
			.select({
				id: jobs.id,
				job_type: jobs.job_type,
				status: jobs.status,
				created_at: jobs.created_at,
			})
			.from(jobs)
			.where(
				and(
					eq(jobs.project_id, projectId),
					eq(jobs.environment_id, envId),
					eq(jobs.org_id, actor.orgId),
				),
			)
			.orderBy(desc(jobs.created_at))
			.limit(8),
		db
			.select({
				details: environmentDrift.details,
				scanned_at: environmentDrift.scanned_at,
			})
			.from(environmentDrift)
			.where(eq(environmentDrift.environment_id, envId))
			.orderBy(desc(environmentDrift.scanned_at))
			.limit(1)
			.then((r) => r[0]),
		db
			.select({
				reachable: environmentProbes.reachable,
				message: environmentProbes.message,
			})
			.from(environmentProbes)
			.where(eq(environmentProbes.environment_id, envId))
			.orderBy(desc(environmentProbes.probed_at))
			.limit(1)
			.then((r) => r[0]),
	]);

	const cost = await getLatestEnvironmentCost(projectId, envId).catch(() => null);

	// GitOps wiring + ArgoCD health (#574) — the Deploy tab's read model, shared here so
	// canvas badges ride the same poll. Best-effort: a read failure must not blank the board.
	const gitops = await readGitopsDeployStatus(projectId, envId).catch(() => null);
	if (gitops) {
		// Per-service ArgoCD health/sync onto the service nodes — the fields existed on
		// ComponentServerStatus since W3 but were never populated (the classic dead slot).
		for (const row of gitops.services) {
			const component = components[`service:${row.name}`];
			if (!component) continue;
			component.health = row.health;
			component.sync = row.sync;
		}
	}

	// Is this environment governed by a bring-your-own IaC module? If so its component rows are
	// INERT — designed but never provisioned, because the module replaced the template — and the
	// architecture is the module's own resources.
	const iac = await getIacEnvironment(projectId, envId);

	let unattributed: DriftDetail[];

	if (iac) {
		// EXACT-ADDRESS attribution. A BYO module's resources ARE Terraform addresses, and so are the
		// drift details and the cost lines — so they join on the nose, with no heuristic.
		//
		// This also closes a real bug: attributing a BYO module's drift through the type→kind + name
		// heuristic below badged the INERT design rows, so a customer module's `aws_eks_*` drift
		// showed up on a design cluster node that does not exist in their cloud. The board lied.
		unattributed = attributeToIacGroups(components, iac, driftRow?.details ?? [], cost);
	} else {
		// Template env: attribute each drifted resource back onto the node that designed it. Anything
		// we can't place (unknown resource type, or an ambiguous kind) rolls up to the environment —
		// never dropped.
		const attribution = attributeDrift(driftRow?.details ?? [], targets);
		unattributed = attribution.unattributed;
		for (const [key, details] of attribution.byKey) {
			const component = components[key];
			if (component) component.drift = details;
		}

		// Cost, from the environment's last PLAN. Infracost prices by Terraform ADDRESS — the same key
		// drift uses — so a cost line lands on the card that designed it via the same map. Lines we can't
		// place still count toward the environment total; they're just not shown on a card, which is the
		// same honesty rule as drift: never attribute a number to a resource it might not belong to.
		if (cost) {
			for (const line of cost.resources) {
				const kind = kindForResourceType(line.resourceType);
				if (!kind) continue;
				const candidates = targets.filter((t) => t.kind === kind);
				// Only attribute when it's unambiguous — one node of that kind, or one whose name the
				// address actually contains.
				const match =
					candidates.length === 1
						? candidates[0]
						: candidates.find((t) => t.name && line.address.includes(t.name));
				if (!match) continue;
				const component = components[match.key];
				if (!component) continue;
				component.monthlyCost = (component.monthlyCost ?? 0) + line.monthlyCost;
				// Keep the line itself, not just the running total — the Cost tab shows the itemised
				// breakdown (Terraform address → monthly), not only the rollup.
				(component.costLines ??= []).push({
					address: line.address,
					monthlyCost: line.monthlyCost,
				});
			}
		}
	}

	return {
		components,
		activeJob: activeJobRow
			? {
					id: activeJobRow.id,
					type: activeJobRow.job_type,
					status: activeJobRow.status,
				}
			: null,
		updatePending: await isDeployPending(projectId, envId, env.deployed_config_hash),
		probe: probeRow
			? { reachable: probeRow.reachable, message: probeRow.message }
			: null,
		unattributedDrift: unattributed,
		driftScannedAt: driftRow?.scanned_at.toISOString() ?? null,
		monthlyCost: cost?.totalMonthly ?? null,
		costCapturedAt: cost?.capturedAt ?? null,
		recentJobs: recentJobRows.map((j) => ({
			id: j.id,
			type: j.job_type,
			status: j.status,
			createdAt: j.created_at.toISOString(),
		})),
		environment: { id: env.id, name: env.name, stage: env.stage, status: env.status },
		iac,
		gitops,
	};
}

/**
 * Resolve the BYO IaC module governing this environment, and derive its architecture.
 *
 * Two inventory sources, in strict precedence (see lib/canvas/iac-inventory.ts): the last
 * SUCCESSFUL plan's `resource_changes` (exact, count/for_each-expanded — and the same addresses
 * cost/drift/verify speak), else the IAC_SCAN's declared skeleton, which lands for free at attach
 * time with no cloud credentials. Returns null for a template environment.
 */
async function getIacEnvironment(
	projectId: string,
	envId: string,
): Promise<IacEnvironment | null> {
	const db = getServiceDb();
	const [row] = await db
		.select()
		.from(projectIacSources)
		.where(
			and(
				eq(projectIacSources.project_id, projectId),
				eq(projectIacSources.environment_id, envId),
				eq(projectIacSources.enabled, true),
			),
		)
		.limit(1);
	if (!row) return null;

	// The last SUCCESSFUL plan for this env — its resource_changes are the real, expanded inventory.
	const [planJob] = await db
		.select({ metadata: jobs.execution_metadata })
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, projectId),
				eq(jobs.environment_id, envId),
				eq(jobs.job_type, "PLAN"),
				eq(jobs.status, "SUCCESS"),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(1);

	const planMembers = parsePlanInventory(planJob?.metadata?.plan_result ?? null);
	const groups = buildIacInventory({
		scanResources: row.scan_report?.resources ?? null,
		planMembers,
	});

	return {
		source: {
			repoUrl: row.repo_url,
			ref: row.ref,
			path: row.path,
			commitSha: row.commit_sha,
			deployedCommitSha: row.deployed_commit_sha,
			scanStatus: row.scan_status,
			// An unscanned module is an honest unknown, not a pass — the deploy gate treats it as
			// blocking, and so must the board.
			scanOk: row.scan_report ? row.scan_report.ok : null,
			status: row.status,
			statusMessage: row.status_message,
		},
		groups,
		// Filled by attributeToIacGroups, which already walks the cost lines.
		costByAddress: {},
		// Root output names ride the same env round-trip as groups (flag-independent), so the bind
		// sheet's facet→output picker has choices even when the BYO-IaC fetch flag is off (#823).
		outputs: row.scan_report?.outputs ?? [],
	};
}

/**
 * Attribute drift and cost onto the external cards by EXACT Terraform address, and register each
 * group in `components` so the canvas resolves it through the same channel as every other node.
 *
 * Returns the drift that belongs to no group — a resource the module builds but neither the scan nor
 * the last plan knows about (e.g. it was added since). It rolls up to the environment rather than
 * being pinned to a card it may not belong to, exactly as unattributable template drift does.
 */
function attributeToIacGroups(
	components: Record<string, ComponentServerStatus>,
	iac: IacEnvironment,
	details: DriftDetail[],
	cost: { resources: { address: string; monthlyCost: number }[] } | null,
): DriftDetail[] {
	const groups = iac.groups;

	// address → group key. One pass, so attribution is O(resources), not O(resources × groups).
	const owner = new Map<string, string>();
	for (const group of groups) {
		for (const member of group.members) owner.set(member.address, group.key);
	}

	for (const group of groups) {
		components[externalStatusKey(group.key)] = {
			// A BYO module applies atomically, so every card in it shares the MODULE's lifecycle
			// (project_iac_sources.status, which finalizeDeployment now writes). The per-group
			// refinement — which of these resources the last plan would still change — happens
			// client-side in `resolveExternalStatus`, where the plan actions live.
			lifecycle: iac.source.status,
			message: iac.source.statusMessage,
			drift: [],
		};
	}

	const unattributed: DriftDetail[] = [];
	for (const detail of details) {
		const key = owner.get(detail.address);
		const component = key ? components[externalStatusKey(key)] : undefined;
		if (component) component.drift.push(detail);
		else unattributed.push(detail);
	}

	for (const line of cost?.resources ?? []) {
		const key = owner.get(line.address);
		const component = key ? components[externalStatusKey(key)] : undefined;
		if (!component) continue; // still counts toward the env total; just not shown on a card
		component.monthlyCost = (component.monthlyCost ?? 0) + line.monthlyCost;
		// Per-address, so a card's panel can say WHICH resource costs the money.
		iac.costByAddress[line.address] =
			(iac.costByAddress[line.address] ?? 0) + line.monthlyCost;
	}

	return unattributed;
}

/**
 * Whether the saved design has moved ahead of what was last deployed — the SAME comparison
 * `getEnvReconcileStates` makes (`structuralHash(design) !== deployed_config_hash`), so the canvas
 * badge and the environment card can never disagree. No deployed hash = never deployed, which is
 * "not deployed", not "update pending". Reading the design can throw (e.g. a since-deleted cloud
 * identity); degrade to "not pending" rather than failing the whole status read.
 */
async function isDeployPending(
	projectId: string,
	environmentId: string,
	deployedHash: string | null,
): Promise<boolean> {
	if (!deployedHash) return false;
	try {
		const design = (await getProjectAsFormData(projectId, environmentId)).formData;
		return structuralHash(design) !== deployedHash;
	} catch {
		return false;
	}
}

/** Attach the non-empty outputs to a component, if it exists. */
function setOutputs(
	components: Record<string, ComponentServerStatus>,
	key: string,
	pairs: [string, string | null | undefined][],
) {
	const component = components[key];
	if (!component) return;
	const outputs = pairs
		.filter((p): p is [string, string] => !!p[1])
		.map(([label, value]) => ({ label, value }));
	if (outputs.length) component.outputs = outputs;
}

/** Record one component row under its canvas key, and register it as a drift-attribution target. */
function addComponent(
	components: Record<string, ComponentServerStatus>,
	targets: DriftTarget[],
	kind: NodeKind,
	row: StatusRow,
) {
	const key = row.name ? `${kind}:${row.name}` : kind;
	components[key] = {
		lifecycle: row.status,
		message: row.status_message,
		drift: [],
	};
	targets.push({ key, kind, name: row.name });
}

// ── Add-ons ────────────────────────────────────────────────────────────────────────────────────

/**
 * The catalog joined with an environment's install state — the Add-ons page payload. Resolves
 * the active environment (the given one, else the project default) since add-ons are
 * environment-scoped.
 */
export async function readProjectAddons(
	projectId: string,
	environmentId?: string | null,
): Promise<ProjectAddonsView> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveEnvironment(projectId, environmentId);

	// `project_addons` / `project_repositories` are RLS-less project-child tables, so the
	// org boundary is enforced HERE, not by a policy: join to the parent project and filter
	// on the caller's org (mirrors lib/queries/evidence.ts queryOrgEvidence and drift.ts).
	// The service db bypasses RLS, so the explicit `projects.org_id = actor.orgId` predicate
	// is the tenancy wall — a foreign project UUID yields no rows even though the org-blind
	// PDP grant let authorize() through. Using actor.orgId (not withActorScope on
	// actor.userId) keeps it correct for Teams orgs (project owned by another member).
	const db = getServiceDb();
	const rows = await db
		.select({
			addon_id: projectAddons.addon_id,
			enabled: projectAddons.enabled,
			mode: projectAddons.mode,
			values: projectAddons.values,
			values_yaml: projectAddons.values_yaml,
			version: projectAddons.version,
			status: projectAddons.status,
			health: projectAddons.health,
			sync_status: projectAddons.sync_status,
			last_synced_at: projectAddons.last_synced_at,
		})
		.from(projectAddons)
		.innerJoin(projects, eq(projectAddons.project_id, projects.id))
		.where(
			and(
				eq(projectAddons.project_id, projectId),
				eq(projectAddons.environment_id, envId),
				eq(projects.org_id, actor.orgId),
			),
		);
	// GitOps mode needs a destination apps repo on this environment.
	const [repo] = await db
		.select({ repo: projectRepositories.apps_destination_repo })
		.from(projectRepositories)
		.innerJoin(projects, eq(projectRepositories.project_id, projects.id))
		.where(
			and(
				eq(projectRepositories.project_id, projectId),
				eq(projectRepositories.environment_id, envId),
				eq(projects.org_id, actor.orgId),
			),
		)
		.limit(1);
	const hasAppsRepo = Boolean(repo?.repo);
	const byId = new Map(rows.map((r) => [r.addon_id, r]));

	const items: AddonMarketItem[] = ADDON_CATALOG.map((def) => {
		const row = byId.get(def.id);
		const install: AddonInstallState | null = row
			? {
					enabled: row.enabled,
					mode: row.mode,
					// Secrets redacted for the client — a set/unset marker, never the stored ciphertext.
					values: redactAddonSecrets(def, row.values ?? {}),
					valuesYaml: row.values_yaml,
					version: row.version,
					status: row.status,
					health: row.health,
					sync: row.sync_status,
					lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
				}
			: null;
		return {
			id: def.id,
			name: def.name,
			category: def.category,
			icon: def.icon,
			summary: def.summary,
			docsUrl: def.docsUrl,
			license: def.license,
			chart: def.chart,
			version: def.version,
			namespace: def.namespace,
			requires: def.requires ?? [],
			fields: def.fields,
			install,
		};
	});

	return { environmentId: envId, items, hasAppsRepo };
}

// ── BYO Helm charts ───────────────────────────────────────────────────────────────────────────

/** Reads the BYO charts attached to an environment — the canvas renders one chart node each. */
export async function readProjectByoCharts(
	projectId: string,
	environmentId?: string | null,
): Promise<{ environmentId: string; charts: ByoChartState[] }> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveEnvironment(projectId, environmentId);
	const rows = await withActorScope(actor, async (tx) =>
		tx
			.select()
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.source, "byo"),
				),
			),
	);
	const charts: ByoChartState[] = rows.map((r) => ({
		id: r.addon_id,
		repoUrl: r.chart_repo ?? "",
		chartPath: r.chart_path ?? "",
		ref: r.version ?? "HEAD",
		namespace: r.namespace ?? "default",
		values: r.values ?? {},
		valuesYaml: r.values_yaml,
		status: r.status,
		health: r.health,
		sync: r.sync_status,
		lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
		scanStatus: r.scan_status,
		scanReport: r.scan_report ?? null,
		scannedAt: r.scanned_at?.toISOString() ?? null,
	}));
	return { environmentId: envId, charts };
}

/**
 * Reads the DESCRIBED workloads of an environment's BYO charts (W5 Path A) — the canvas renders each
 * as a service-like child of its chart node (joined back to the chart's slug via the addon uuid).
 * Empty until a CHART_SCAN has run with the describe flag on.
 */
export async function readProjectChartWorkloads(
	projectId: string,
	environmentId?: string | null,
): Promise<{ environmentId: string; workloads: ChartWorkloadState[] }> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveEnvironment(projectId, environmentId);
	const { rows, bindingsByWorkload } = await withActorScope(actor, async (tx) => {
		const rows = await tx
			.select({
				id: projectChartWorkloads.id,
				chartId: projectAddons.addon_id,
				name: projectChartWorkloads.name,
				kind: projectChartWorkloads.workload_kind,
				rendered: projectChartWorkloads.rendered,
				config: projectChartWorkloads.config,
				valuePaths: projectChartWorkloads.value_paths,
			})
			.from(projectChartWorkloads)
			.innerJoin(
				projectAddons,
				eq(projectChartWorkloads.addon_id, projectAddons.id),
			)
			.where(
				and(
					eq(projectChartWorkloads.project_id, projectId),
					eq(projectChartWorkloads.environment_id, envId),
				),
			);
		// Bindings live in the service_bindings child table (JSONB dropped, #1426).
		const bindingsByWorkload = await serviceBindingsByOwner(tx, {
			serviceIds: [],
			chartWorkloadIds: rows.map((r) => r.id),
		});
		return { rows, bindingsByWorkload };
	});
	return {
		environmentId: envId,
		workloads: rows.map((r) => ({
			id: r.id,
			chartId: r.chartId,
			name: r.name,
			kind: r.kind,
			rendered: r.rendered,
			bindings: bindingsByWorkload.get(r.id) ?? [],
			config: r.config,
			valuePaths: r.valuePaths,
		})),
	};
}

// ── The environment's jobs (the Activity card) ────────────────────────────────────────────────

/**
 * The environment must belong to the project, in the actor's org. A miss is a typed NOT_FOUND
 * (`lib/rpc/base.ts`), so the Activity card renders "not found", never an empty history.
 */
async function assertEnvironmentInOrg(projectId: string, environmentId: string, orgId: string) {
	const [env] = await getServiceDb()
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.where(
			and(
				eq(projectEnvironments.id, environmentId),
				eq(projectEnvironments.project_id, projectId),
				eq(projects.org_id, orgId),
			),
		)
		.limit(1);
	if (!env) throw new ActionRefusal("not-found", "Environment not found.");
}

/** The keyset cursor: the last row's `created_at` (ISO) and id, joined so ties on time are stable. */
function encodeCursor(job: { created_at: Date; id: string }): string {
	return `${job.created_at.toISOString()}|${job.id}`;
}

/** Parse a cursor back into its two keys; a malformed one reads as "no cursor" (first page). */
function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
	if (!cursor) return null;
	const sep = cursor.lastIndexOf("|");
	if (sep <= 0) return null;
	const at = new Date(cursor.slice(0, sep));
	if (Number.isNaN(at.getTime())) return null;
	return { at, id: cursor.slice(sep + 1) };
}

/**
 * The environment's jobs — the activity card. Scoped to ONE environment, because the board only
 * ever shows one, and a project-wide list would attribute another environment's failure to the
 * design you're looking at.
 *
 * Keyset-paginated on `(created_at, id)`: the floating rail this used to feed took the newest
 * eight and stopped, so an environment's history ended wherever the list did. `before` is the
 * cursor the previous page returned; a page fetches one row past `limit` to know whether there
 * is another, and never returns that extra row.
 */
export async function readEnvironmentJobs(
	projectId: string,
	environmentId: string,
	opts: { limit?: number; before?: string } = {},
): Promise<EnvironmentJobsPage> {
	const actor = await authorize("view", { type: "project", id: projectId });
	await assertEnvironmentInOrg(projectId, environmentId, actor.orgId);
	const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
	const before = decodeCursor(opts.before);

	const db = getServiceDb();
	const rows = await db
		.select({
			id: jobs.id,
			job_type: jobs.job_type,
			status: jobs.status,
			created_at: jobs.created_at,
			error_message: jobs.error_message,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.project_id, projectId),
				eq(jobs.environment_id, environmentId),
				eq(jobs.org_id, actor.orgId),
				before
					? or(
							lt(jobs.created_at, before.at),
							and(eq(jobs.created_at, before.at), lt(jobs.id, before.id)),
						)
					: undefined,
			),
		)
		.orderBy(desc(jobs.created_at), desc(jobs.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		jobs: page.map((r) => ({
			id: r.id,
			type: r.job_type,
			status: r.status,
			createdAt: r.created_at.toISOString(),
			error: r.error_message,
		})),
		nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
	};
}

// ── Capabilities: what a cloud identity can actually launch ───────────────────────────────────

/** Rows=0 with a stamp this fresh is read as "still enumerating" rather than "nothing to report". */
const SYNCING_WINDOW_MS = 5 * 60_000;

/** The clouds with a provisioning-option catalog. Cast-free narrowing: returns the matching literal
 * (already the union type) so a wider `cloud_provider` value degrades to null instead of lying. */
function asCatalogued(p: string): CloudProviderSlug | null {
	const catalogued: CloudProviderSlug[] = ["aws", "gcp", "azure", "hetzner", "alibaba"];
	return catalogued.find((c) => c === p) ?? null;
}

/**
 * Everything the canvas pickers need for one cloud identity, in one round trip.
 *
 * `region` scopes the axes that are genuinely per-region. Pass null and those axes are SKIPPED and
 * reported as `catalog`: reading them region-less returns the union across regions, which yields a
 * false "launchable" for a type that is only launchable somewhere else — worse than no signal. It
 * also bounds the payload (AWS enumerates ~700 instance types).
 */
export async function readIdentityCapabilities(
	cloudIdentityId: string,
	region?: string | null,
): Promise<CapabilityBag> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});

	// Derive the provider (and the sync stamp) from the identity itself, under withActorScope so
	// Postgres RLS is the tenancy wall. `cloud_identities` carries the `owner_all` policy, so there
	// is no reason to reach for the RLS-bypassing service role here and re-implement the boundary as
	// a hand-written org predicate — a predicate is only as good as the column it names, and RLS is
	// the wall that is actually tested.
	const [identity] = await withActorScope(actor, (tx) =>
		tx
			.select({
				provider: cloudIdentities.provider,
				syncedAt: cloudIdentities.capabilities_synced_at,
			})
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloudIdentityId))
			.limit(1),
	);

	if (!identity) return emptyBag();

	// `cloud_provider` is wider than the catalogued set: digitalocean/civo have no capability lane
	// and no static option catalog, so there is nothing to resolve for them. Narrow explicitly and
	// return the empty bag — every picker then shows exactly what it shows today.
	const provider = asCatalogued(identity.provider);
	if (!provider) return emptyBag();
	const scoped = region ?? null;

	const [
		regions,
		instanceTypes,
		k8sVersions,
		database,
		dbInstanceClasses,
		cacheTiers,
		cacheVersions,
		nosql,
		inventory,
	] = await Promise.all([
		getRegionCapabilities(cloudIdentityId, provider),
		scoped ? getInstanceTypeCapabilities(cloudIdentityId, provider, scoped) : [],
		getK8sVersionCapabilities(cloudIdentityId, provider),
		getDatabaseCapabilities(cloudIdentityId, provider),
		// NOT engine-filtered here: the bag is fetched once per node and the engine can change without
		// a refetch, so the whole SKU set is carried and `dbInstanceClassOptions` narrows on render.
		getDbInstanceClassCapabilities(cloudIdentityId, provider),
		scoped ? getCacheTierCapabilities(cloudIdentityId, provider, scoped) : [],
		getCacheVersionCapabilities(cloudIdentityId, provider),
		getNosqlCapability(cloudIdentityId, provider),
		getCloudIdentityInventory(cloudIdentityId).catch(() => ({
			networks: [],
			subnets: [],
			regions: [],
		})),
	]);

	// `launchable === undefined` marks a static fallback row, so it doubles as the provenance signal
	// for every axis except regions (whose reader reports its own source).
	const sourceOf = (rows: { launchable?: string }[]): "account" | "catalog" =>
		rows.some((r) => r.launchable !== undefined) ? "account" : "catalog";

	const axisSource: Record<CapabilityAxis, "account" | "catalog"> = {
		region: regions.source,
		instance_type: scoped ? sourceOf(instanceTypes) : "catalog",
		k8s_version: sourceOf(k8sVersions),
		database: sourceOf(database.engines),
		// These two have no catalog fallback at all, so their readers return [] rather than static rows:
		// any row is account data, and none means there is nothing to show (see `provenanceNote`).
		db_instance_class: dbInstanceClasses.length > 0 ? "account" : "catalog",
		cache_tier: scoped ? sourceOf(cacheTiers) : "catalog",
		cache_version: cacheVersions.length > 0 ? "account" : "catalog",
		nosql: nosql.launchable !== undefined ? "account" : "catalog",
		placement: inventory.networks.length > 0 ? "account" : "catalog",
	};

	// `state` describes the CAPABILITY sync (it is derived from capabilities_synced_at), so placement
	// is deliberately excluded: inventory is populated by a different sweeper, and an account with
	// synced VPCs but no capability rows would otherwise report "ready" while it is still enumerating.
	const CAPABILITY_AXES: CapabilityAxis[] = [
		"region",
		"instance_type",
		"k8s_version",
		"database",
		"db_instance_class",
		"cache_tier",
		"cache_version",
		"nosql",
	];
	const anyAccount = CAPABILITY_AXES.some((axis) => axisSource[axis] === "account");

	return {
		identityId: cloudIdentityId,
		provider,
		region: scoped,
		state: syncState(anyAccount, identity.syncedAt),
		axisSource,
		regions: regions.codes,
		instanceTypes: instanceTypes.map((r) => ({
			value: r.value,
			label:
				r.vcpu != null && r.memoryGb != null
					? `${r.label} · ${r.vcpu} vCPU / ${r.memoryGb} GB`
					: r.label,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		k8sVersions: k8sVersions.map((r) => ({
			value: r.version,
			label: r.version,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		// The engine's OWN label, not a composite with the version (#1351): the version is its own
		// picker now, so folding it into the engine label would make the two axes disagree.
		dbEngines: database.engines.map((r) => ({
			value: r.value,
			label: r.label,
			versions: r.versions,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		// The SKU's memory is the only thing that makes one comparable to another at a glance; where the
		// provider doesn't report it the label stays the bare SKU rather than claiming a size.
		dbInstanceClasses: dbInstanceClasses.map((r) => ({
			value: r.value,
			label: r.memoryGb != null ? `${r.label} · ${r.memoryGb} GB` : r.label,
			engine: r.engine,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		cacheVersions: cacheVersions.map((r) => ({
			value: r.version,
			label: r.version,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		cacheTiers: cacheTiers.map((r) => ({
			value: r.value,
			label:
				r.memoryGb != null
					? `${r.label} · ${r.memoryGb} GB${r.cost ? ` (${r.cost})` : ""}`
					: r.label,
			launchable: r.launchable,
			launchableReason: r.launchableReason ?? null,
		})),
		// The key-type SHAPE is static provider metadata, not an enumerated axis — the account verdict
		// applies to the service as a whole, so it rides on every key type.
		nosqlKeyTypes: nosql.available
			? nosql.config.keyTypes.map((k) => ({
					value: k.value,
					label: k.label,
					launchable: nosql.launchable,
					launchableReason: nosql.launchableReason ?? null,
				}))
			: [],
		networks: inventory.networks.map((n) => ({
			nativeId: n.native_id,
			name: n.name,
			region: n.region,
			cidrBlock: n.cidr_block,
			isDefault: Boolean(n.is_default),
		})),
		subnets: inventory.subnets.map((s) => ({
			nativeId: s.native_id,
			name: s.name,
			region: s.region,
			cidrBlock: s.cidr_block,
			isDefault: false,
			availabilityZone: s.availability_zone,
			isPublic: Boolean(s.is_public),
			// The subnet's parent is stored as the cloud_networks ROW id; the picker matches on the
			// native id, so resolve it against the networks we just read.
			networkRowId:
				inventory.networks.find((n) => n.id === s.network_id)?.native_id ?? null,
		})),
	};
}

/**
 * Honest sync state. `claimDueCapability` stamps `capabilities_synced_at` BEFORE enumerating, so
 * "rows=0 with a recent stamp" is genuinely ambiguous between in-flight and produced-nothing. The
 * window is an approximation, not a fact — a real `capabilities_sync_status` column would settle it,
 * but that needs the board-mutex'd migration and this must not block on one.
 */
function syncState(
	anyAccountRows: boolean,
	syncedAt: Date | null,
): CapabilityBag["state"] {
	if (anyAccountRows) return "ready";
	if (syncedAt === null) return "syncing";
	return Date.now() - syncedAt.getTime() < SYNCING_WINDOW_MS ? "syncing" : "ready";
}

function emptyBag(): CapabilityBag {
	const catalog: Record<CapabilityAxis, "account" | "catalog"> = {
		region: "catalog",
		instance_type: "catalog",
		k8s_version: "catalog",
		database: "catalog",
		db_instance_class: "catalog",
		cache_tier: "catalog",
		cache_version: "catalog",
		nosql: "catalog",
		placement: "catalog",
	};
	return {
		identityId: null,
		provider: null,
		region: null,
		state: "idle",
		axisSource: catalog,
		regions: [],
		instanceTypes: [],
		k8sVersions: [],
		dbEngines: [],
		dbInstanceClasses: [],
		cacheTiers: [],
		cacheVersions: [],
		nosqlKeyTypes: [],
		networks: [],
		subnets: [],
	};
}

// ── The destroy tree: what destroying the environment destroys (#5249, #5261) ─────────────────

/**
 * The DESTROY TREE of an environment: the environment plus every live tenant placed on the Fabric it
 * owns, in the order a cascade destroys them — tenants first, the owner last. A non-dedicated
 * environment's tree is itself alone. Read by the board's Destroy (which asks BEFORE it offers to
 * destroy, so the tenants it names are seen first) and by `alethia project destroy --cascade`.
 *
 * `view`, not `destroy`: it reveals nothing the environment list does not, and showing someone what
 * a destroy WOULD do must not require being allowed to do it.
 *
 * A named environment is read EXACTLY — never the project's default in its place — and only inside
 * the actor's org: the PDP's answer for an org-wide role does not bind the project id it was asked
 * about, so the row is joined to its project's org. A null environment means the project's default.
 *
 * The board's Destroy (`destroyEnvironmentAction`) resolves its target through THIS read too and
 * queues the destroy on the environment it returns, so the tree the dialog shows and the environment
 * the destroy takes cannot disagree: a stale id is a not-found for both, never the default.
 */
export async function readDestroyTree(
	projectId: string,
	environmentId: string | null | undefined,
): Promise<{ environmentId: string; tree: DestroyTreeNode[] }> {
	const actor = await authorize("view", { type: "project", id: projectId });
	return withActorScope(actor, async (tx) => {
		const [target] = await tx
			.select({
				id: projectEnvironments.id,
				name: projectEnvironments.name,
				project_id: projectEnvironments.project_id,
				fabric_id: projectEnvironments.fabric_id,
				placement_mode: projectEnvironments.placement_mode,
				status: projectEnvironments.status,
			})
			.from(projectEnvironments)
			.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
			.where(
				and(
					eq(projectEnvironments.project_id, projectId),
					eq(projects.org_id, actor.orgId),
					environmentId
						? eq(projectEnvironments.id, environmentId)
						: eq(projectEnvironments.is_default, true),
				),
			)
			.limit(1);
		if (!target) throw new ActionRefusal("not-found", "Environment not found.");
		const tenants = await readLiveFabricTenants(tx, target);
		return { environmentId: target.id, tree: buildDestroyTree(target, tenants) };
	});
}

// ── The procedures ─────────────────────────────────────────────────────────────────────────────

/** A project and one of its environments; a null environment means the project's default one. */
const environmentInput = z.object({
	projectId: z.string().uuid(),
	environmentId: z.string().uuid().nullable(),
});

/** The input of {@link canvasRouter}'s environment-scoped reads. */
export type CanvasEnvironmentInput = z.infer<typeof environmentInput>;

/**
 * The canvas domain's read procedures (ADR 0005 D1, #6119). Every one is a GET (the `query` base),
 * prefetched by the Architecture page where it is first-paint data and invalidated by the
 * real-time bus (`lib/query/topics.ts`) instead of polled.
 */
export const canvasRouter = {
	/** The environment's server truth: component lifecycles, the in-flight job, drift, cost, IaC. */
	environmentStatus: query
		.input(environmentInput)
		.handler(({ input }) => readEnvironmentStatus(input.projectId, input.environmentId)),
	/** The add-on catalog joined with the environment's install state. */
	addons: query
		.input(environmentInput)
		.handler(({ input }) => readProjectAddons(input.projectId, input.environmentId)),
	/** The BYO Helm charts attached to the environment (one chart node each). */
	byoCharts: query
		.input(environmentInput)
		.handler(({ input }) => readProjectByoCharts(input.projectId, input.environmentId)),
	/** The described workloads of the environment's BYO charts. */
	chartWorkloads: query
		.input(environmentInput)
		.handler(({ input }) => readProjectChartWorkloads(input.projectId, input.environmentId)),
	/**
	 * The environment's attached BYO IaC source (`source`, null when none), with the environment it
	 * resolved — so an answer always names whose environment it is, even when there is no source.
	 */
	iacSource: query.input(environmentInput).handler(async ({ input }) => {
		// Authorize BEFORE resolving: the resolution reads the project's environments.
		await authorize("view", { type: "project", id: input.projectId });
		const environmentId = await resolveEnvironment(input.projectId, input.environmentId);
		return { environmentId, source: await getIacSource(input.projectId, environmentId) };
	}),
	/** One page of the environment's jobs, newest first (the Activity card). */
	environmentJobs: query
		.input(
			z.object({
				projectId: z.string().uuid(),
				environmentId: z.string().uuid(),
				limit: z.number().int().min(1).max(100).optional(),
				before: z.string().max(200).optional(),
			}),
		)
		.handler(({ input }) =>
			readEnvironmentJobs(input.projectId, input.environmentId, {
				limit: input.limit,
				before: input.before,
			}),
		),
	/** What destroying the environment destroys: its live tenants first, the environment last. */
	destroyTree: query
		.input(environmentInput)
		.handler(({ input }) => readDestroyTree(input.projectId, input.environmentId)),
	/** The capability bag a canvas node's pickers resolve against, for one identity and region. */
	capabilities: query
		.input(
			z.object({
				identityId: z.string().uuid(),
				region: z.string().max(64).nullable(),
			}),
		)
		.handler(({ input }) => readIdentityCapabilities(input.identityId, input.region)),
	/** A cloud identity's live network inventory (networks, subnets, regions). */
	cloudInventory: query
		.input(z.object({ identityId: z.string().uuid() }))
		.handler(({ input }) => getCloudIdentityInventory(input.identityId)),
};
