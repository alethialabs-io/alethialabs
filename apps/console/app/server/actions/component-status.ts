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
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectSecrets,
	projectStorageBuckets,
	projectTopics,
	projects,
} from "@/lib/db/schema";
import type { ComponentStatus } from "@/lib/db/schema/enums";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type ComponentServerStatus,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { attributeDrift, type DriftTarget } from "@/lib/canvas/drift-map";
import { structuralHash } from "@/lib/promotions/diff";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";

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

	const [activeJobRow, driftRow, probeRow] = await Promise.all([
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

	// Attribute each drifted resource back onto the node that designed it. Anything we can't place
	// (unknown resource type, or an ambiguous kind) rolls up to the environment — never dropped.
	const { byKey, unattributed } = attributeDrift(driftRow?.details ?? [], targets);
	for (const [key, details] of byKey) {
		const component = components[key];
		if (component) component.drift = details;
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
	};
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
