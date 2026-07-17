"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The server half of canvas node status (W3). Every state below already existed in the database and
// reached nothing: component_status on each project_* table, the env's in-flight job, environment_drift,
// environment_probes. This is the single round-trip that brings them to the canvas, keyed by
// nodeStatusKey() — the join key the canvas was designed around from the start.

import { and, desc, eq, inArray } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import {
	environmentDrift,
	environmentProbes,
	jobs,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectIacSources,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectSecrets,
	projectServices,
	projectStorageBuckets,
	projectTopics,
	projects,
} from "@/lib/db/schema";
import type { ComponentStatus } from "@/lib/db/schema/enums";
import {
	EMPTY_ENVIRONMENT_STATUS,
	externalStatusKey,
	type ComponentServerStatus,
	type EnvironmentStatus,
	type IacEnvironment,
} from "@/lib/canvas/component-status";
import { attributeDrift, kindForResourceType, type DriftTarget } from "@/lib/canvas/drift-map";
import { readGitopsDeployStatus } from "@/lib/gitops/deploy-status";
import { buildIacInventory, parsePlanInventory } from "@/lib/canvas/iac-inventory";
import { getLatestEnvironmentCost } from "@/app/server/actions/cost";
import { structuralHash } from "@/lib/promotions/diff";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type { DriftDetail } from "@/types/jsonb.types";

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
export async function getEnvironmentComponentStatus(
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
