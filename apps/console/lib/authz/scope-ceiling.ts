// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The scope ceiling (agent surface §4.4): effective permission = the user's PDP grant ∩ the
// credential's scopes ∩ the credential's project list. This module owns the second and third
// terms — which scope each action needs, which projects a reference touches — and the PDP wrapper
// that `getPdp` returns, so every route and tool that asks the PDP is held to the ceiling of the
// actor it asks about.

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AGENT_SCOPES, type AgentScope } from "@/lib/approvals/types";
import { enforceDecision } from "@/lib/authz/activity";
import type { Action, Resource } from "@/lib/authz/registry";
import {
	type BulkCheck,
	type Decision,
	ForbiddenError,
	type Pdp,
	type ResolvedScope,
	type ResourceRef,
	type ScopeCeiling,
} from "@/lib/authz/types";
import { isEnumMember } from "@/lib/coerce";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/** The reason a decision carries when the credential's scopes do not cover the action. */
export const INSUFFICIENT_SCOPE = "insufficient_scope";

/** The reason a decision carries when the reference is outside the credential's project list. */
export const PROJECT_NOT_PERMITTED = "project_not_permitted";

/** The ceiling of a credential with every scope over every project: it narrows nothing. */
export const UNRESTRICTED_CEILING: ScopeCeiling = { scopes: AGENT_SCOPES, projectIds: null };

/**
 * The scopes a credential must carry for `action` on a `resource` of this type. Every listed scope
 * is required.
 *
 * The five scopes name the agent lifecycle on a project: `read` anything, `design` a project,
 * `plan` (including an audit, and the job records a plan creates), `apply`, `destroy`. Every other
 * action — membership, billing, tokens, connectors, cloud identities, runners, fleet, alert rules,
 * support triage, cluster administration — is administration of the org, and needs every scope at
 * once, so only a credential with no scope limit can take it.
 *
 * A `switch` with a `never` default, so a new action is a type error here until it is given an
 * answer, instead of silently inheriting one.
 */
export function requiredScopes(action: Action, resource: Resource): readonly AgentScope[] {
	switch (action) {
		case "view":
		case "view_activity":
		case "view_alerts":
		case "access_readonly":
			return ["read"];
		case "plan":
		case "audit":
			return ["plan"];
		case "create":
		case "edit":
			if (resource === "project") return ["design"];
			if (resource === "job") return ["plan"];
			return AGENT_SCOPES;
		case "deploy":
			return resource === "project" ? ["apply"] : AGENT_SCOPES;
		case "destroy":
			return resource === "project" ? ["destroy"] : AGENT_SCOPES;
		case "test":
		case "manage_identities":
		case "manage_members":
		case "manage_connectors":
		case "export_activity":
		case "manage_billing":
		case "manage_alerts":
		case "reply":
		case "manage_support":
		case "manage_tokens":
		case "manage_agents":
		case "access_admin":
			return AGENT_SCOPES;
		default: {
			const unhandled: never = action;
			return unhandled;
		}
	}
}

/** True when every scope `needed` is one the ceiling carries. */
function coversScopes(ceiling: ScopeCeiling, needed: readonly AgentScope[]): boolean {
	return needed.every((scope) => ceiling.scopes.includes(scope));
}

/**
 * How a resource type relates to a project list:
 * - `project` — the reference IS a project.
 * - `job` — the reference belongs to the project its row names.
 * - `project_owned` — it belongs to a project this module cannot resolve, so a project-limited
 *   credential is refused it outright.
 * - `org` — it belongs to the org, not to a project. Org-level reads (usage, assignments, members)
 *   can describe every project, so a project-limited credential is refused these too.
 */
type ProjectRelation = "project" | "job" | "project_owned" | "org";

/** The {@link ProjectRelation} of each resource type. A record, so a new type must be placed. */
const PROJECT_RELATION: Record<Resource, ProjectRelation> = {
	project: "project",
	job: "job",
	cluster: "project_owned",
	org: "org",
	runner: "org",
	cloud_identity: "org",
	connector: "org",
	member: "org",
	activity: "org",
	billing: "org",
	alert: "org",
	fleet: "org",
	support_case: "org",
};

/** A refusal for the given reason. */
function refused(reason: string): Decision {
	return { allowed: false, reason };
}

/** The project ids, among `jobIds` in `orgId`, of the jobs that name one. */
async function jobProjects(
	orgId: string,
	jobIds: readonly string[],
): Promise<Map<string, string | null>> {
	// Only uuid-shaped ids reach the query: anything else names no job, and Postgres would reject it.
	const ids = jobIds.filter((id) => z.uuid().safeParse(id).success);
	if (ids.length === 0) return new Map();
	const rows = await getServiceDb()
		.select({ id: jobs.id, project_id: jobs.project_id })
		.from(jobs)
		.where(and(inArray(jobs.id, ids), eq(jobs.org_id, orgId)));
	return new Map(rows.map((row) => [row.id, row.project_id]));
}

/**
 * The ceiling's answer for one reference: allowed, or refused with {@link INSUFFICIENT_SCOPE} or
 * {@link PROJECT_NOT_PERMITTED}. An actor with no ceiling is always allowed here; the PDP decides.
 *
 * Under a project list, a reference is admitted only when the projects it touches are provably on
 * the list:
 * - a project by id: on the list;
 * - a project with no id (a create, a list): refused, because the projects it would reach are not
 *   known here — a list of projects comes through `listAccessible`, which filters to the list;
 * - a job by id: its row is read in the actor's org and its project must be on the list; a job with
 *   no id, no row, or no project is refused;
 * - a resource owned by a project this module cannot resolve (a cluster): refused;
 * - an org-level resource: refused. An org-level read can describe every project in the org, so
 *   a project-limited credential reaches only its projects and their jobs.
 */
export async function ceilingDecision(
	actor: ResolvedScope,
	action: Action,
	resource: ResourceRef,
): Promise<Decision> {
	const ceiling = actor.ceiling;
	if (!ceiling) return { allowed: true };
	const needed = requiredScopes(action, resource.type);
	if (!coversScopes(ceiling, needed)) return refused(INSUFFICIENT_SCOPE);
	const projectIds = ceiling.projectIds;
	if (projectIds === null) return { allowed: true };

	switch (PROJECT_RELATION[resource.type]) {
		case "project":
			return resource.id && projectIds.includes(resource.id)
				? { allowed: true }
				: refused(PROJECT_NOT_PERMITTED);
		case "job": {
			if (!resource.id) return refused(PROJECT_NOT_PERMITTED);
			const project = (await jobProjects(actor.orgId, [resource.id])).get(resource.id);
			return project && projectIds.includes(project)
				? { allowed: true }
				: refused(PROJECT_NOT_PERMITTED);
		}
		case "project_owned":
		case "org":
			return refused(PROJECT_NOT_PERMITTED);
	}
}

/**
 * `ids` (what the PDP allows `actor` to `action` on `resourceType`) narrowed to the ceiling, by the
 * same rules as {@link ceilingDecision}.
 */
export async function filterToCeiling(
	actor: ResolvedScope,
	action: Action,
	resourceType: Resource,
	ids: string[],
): Promise<string[]> {
	const ceiling = actor.ceiling;
	if (!ceiling) return ids;
	const needed = requiredScopes(action, resourceType);
	if (!coversScopes(ceiling, needed)) return [];
	const projectIds = ceiling.projectIds;
	if (projectIds === null) return ids;

	switch (PROJECT_RELATION[resourceType]) {
		case "project":
			return ids.filter((id) => projectIds.includes(id));
		case "job": {
			const projects = await jobProjects(actor.orgId, ids);
			return ids.filter((id) => {
				const project = projects.get(id);
				return Boolean(project && projectIds.includes(project));
			});
		}
		case "project_owned":
		case "org":
			return [];
	}
}

/**
 * The PDP `getPdp` hands out: `inner`'s decisions, held to the ceiling of the actor asked about.
 * An actor with no ceiling is passed straight through, so a person's decisions are unchanged.
 *
 * - `can` and `bulkCheck`: a ceiling refusal wins over the PDP's allow.
 * - `enforce`: a ceiling refusal is recorded and thrown exactly as a PDP denial is
 *   (`enforceDecision`), so the activity log and alert rules see it.
 * - `listAccessible`: the PDP's ids, narrowed by {@link filterToCeiling}.
 */
export function withScopeCeiling(inner: Pdp): Pdp {
	return {
		async can(actor, action, resource) {
			const limit = await ceilingDecision(actor, action, resource);
			if (!limit.allowed) return limit;
			return inner.can(actor, action, resource);
		},
		async enforce(actor, action, resource) {
			const limit = await ceilingDecision(actor, action, resource);
			if (!limit.allowed) {
				enforceDecision(actor, action, resource, limit);
				// `enforceDecision` throws on a refusal; this keeps the wrapper closed if it ever stops.
				throw new ForbiddenError(action, resource, limit.reason);
			}
			return inner.enforce(actor, action, resource);
		},
		async bulkCheck(actor, checks: BulkCheck[]) {
			const [limits, decisions] = await Promise.all([
				Promise.all(checks.map((c) => ceilingDecision(actor, c.action, c.resource))),
				inner.bulkCheck(actor, checks),
			]);
			return decisions.map((decision, i) => {
				const limit = limits[i];
				return limit && !limit.allowed ? limit : decision;
			});
		},
		async listAccessible(actor, action, resourceType) {
			const ids = await inner.listAccessible(actor, action, resourceType);
			return filterToCeiling(actor, action, resourceType, ids);
		},
	};
}

/**
 * Reads a scope list from untrusted input (a token claim, a stored row): a non-empty array of known
 * scopes, de-duplicated, or `null`. Anything else — absent, empty, not an array, or holding a value
 * that is not a scope — is `null`, and a caller refuses the credential.
 */
export function parseScopes(value: unknown): AgentScope[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const scopes: AgentScope[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !isEnumMember(item, AGENT_SCOPES)) return null;
		if (!scopes.includes(item)) scopes.push(item);
	}
	return scopes;
}

/**
 * Reads a project list from untrusted input: `null` (every project), or a non-empty array of
 * non-blank strings. `undefined` is NOT `null` — an absent list is refused, so only a writer that
 * stated "every project" gets it. Returns `{ ok: false }` for anything else.
 */
export function parseProjectIds(
	value: unknown,
): { ok: true; projectIds: string[] | null } | { ok: false } {
	if (value === null) return { ok: true, projectIds: null };
	if (!Array.isArray(value) || value.length === 0) return { ok: false };
	const ids: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.trim() === "") return { ok: false };
		if (!ids.includes(item)) ids.push(item);
	}
	return { ok: true, projectIds: ids };
}

/**
 * A ceiling from untrusted scope and project-list values, or `null` when either cannot be read.
 * See {@link parseScopes} and {@link parseProjectIds}.
 */
export function ceilingFrom(scopes: unknown, projectIds: unknown): ScopeCeiling | null {
	const parsedScopes = parseScopes(scopes);
	if (!parsedScopes) return null;
	const parsedProjects = parseProjectIds(projectIds);
	if (!parsedProjects.ok) return null;
	return { scopes: parsedScopes, projectIds: parsedProjects.projectIds };
}

/** True when the ceiling narrows nothing: every scope, every project. */
export function isUnrestricted(ceiling: ScopeCeiling): boolean {
	return ceiling.projectIds === null && coversScopes(ceiling, AGENT_SCOPES);
}
