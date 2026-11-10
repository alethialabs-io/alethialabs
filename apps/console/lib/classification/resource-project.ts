// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Classification on a resource that belongs to a PROJECT follows that project's permissions.
//
// Reading and changing a resource's classification values is gated on the ORG (`view` / `edit` on
// `{ type: "org" }`), because the dimensions and values are the org's. A grant or deny scoped to one
// project is not part of that answer. So for the three kinds that live inside a project — the
// project itself, its environments and its clusters — the caller is also asked the same action
// about THAT project: a member who may not view a project does not read its labels, and a member who
// may not edit it does not change them.
//
// Both the console's server actions (app/server/actions/classification/assignments.ts) and the CLI
// route (app/api/cli/classification/assignments/route.ts) ask through here, so the two answer alike.
// The per-project question itself is `cliMayActOnProject` (lib/cli/project-access.ts): asked with
// `can()`, recorded and emitted only on a refusal.

import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Action } from "@/lib/authz/registry";
import type { Actor } from "@/lib/authz/types";
import { cliMayActOnProject, cliViewableProjectIds } from "@/lib/cli/project-access";
import { getServiceDb } from "@/lib/db";
import { projectCluster, projectEnvironments, projects } from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";

/** The resource kinds that live inside a project. */
const PROJECT_BOUND_KINDS = ["project", "project_environment", "project_cluster"] as const;
type ProjectBoundKind = (typeof PROJECT_BOUND_KINDS)[number];

/** True when `kind` is a resource that lives inside a project. */
function isProjectBound(kind: ResourceKind): kind is ProjectBoundKind {
	return PROJECT_BOUND_KINDS.some((k) => k === kind);
}

/**
 * The `[resourceId, projectId]` pairs, among `resourceIds` of `kind`, whose project lives in
 * `orgId`. Read on the service role, so the `projects.org_id` predicate is the tenancy wall. An id
 * that is not a uuid, unknown, or in another org yields no pair.
 */
async function projectsOf(
	kind: ProjectBoundKind,
	resourceIds: readonly string[],
	orgId: string,
): Promise<[string, string][]> {
	const ids = resourceIds.filter((id) => z.uuid().safeParse(id).success);
	if (ids.length === 0) return [];
	const db = getServiceDb();
	switch (kind) {
		case "project":
			return (
				await db
					.select({ id: projects.id })
					.from(projects)
					.where(and(inArray(projects.id, ids), eq(projects.org_id, orgId)))
			).map((r) => [r.id, r.id]);
		case "project_environment":
			return (
				await db
					.select({ id: projectEnvironments.id, projectId: projects.id })
					.from(projectEnvironments)
					.innerJoin(projects, eq(projects.id, projectEnvironments.project_id))
					.where(and(inArray(projectEnvironments.id, ids), eq(projects.org_id, orgId)))
			).map((r) => [r.id, r.projectId]);
		case "project_cluster":
			return (
				await db
					.select({ id: projectCluster.id, projectId: projects.id })
					.from(projectCluster)
					.innerJoin(projects, eq(projects.id, projectCluster.project_id))
					.where(and(inArray(projectCluster.id, ids), eq(projects.org_id, orgId)))
			).map((r) => [r.id, r.projectId]);
	}
}

/**
 * True when `actor` may `action` the classification of the `kind` resource `resourceId` as far as
 * its project is concerned:
 *
 *   - a kind that does not live in a project → nothing to ask (true);
 *   - a resource not found in `actor.orgId` → not this question (true). The caller's own org check
 *     (`classifiableResourceInOrg` on a write; the org predicate on every assignment read) is what
 *     answers for that;
 *   - otherwise `cliMayActOnProject(actor, <its project>, action)`, which records a refusal.
 */
export async function mayClassifyResource(
	actor: Actor,
	kind: ResourceKind,
	resourceId: string,
	action: Action,
): Promise<boolean> {
	if (!isProjectBound(kind)) return true;
	const [pair] = await projectsOf(kind, [resourceId], actor.orgId);
	if (!pair) return true;
	return cliMayActOnProject(actor, pair[1], action);
}

/**
 * The list form of {@link mayClassifyResource} for `view`: `resourceIds` without the ones whose
 * project (in `actor.orgId`) the caller may not view. Not recorded, as a list leaving a row out is
 * not a refusal of a request for it.
 */
export async function classifiedIdsViewable(
	actor: Actor,
	kind: ResourceKind,
	resourceIds: string[],
): Promise<string[]> {
	if (!isProjectBound(kind) || resourceIds.length === 0) return resourceIds;
	const owned = await projectsOf(kind, resourceIds, actor.orgId);
	if (owned.length === 0) return resourceIds;
	const viewable = new Set(await cliViewableProjectIds(actor));
	const hidden = new Set(owned.filter(([, projectId]) => !viewable.has(projectId)).map(([id]) => id));
	return resourceIds.filter((id) => !hidden.has(id));
}
