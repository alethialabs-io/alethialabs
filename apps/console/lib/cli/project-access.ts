// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The front door of every CLI route that addresses ONE project by its id, name or slug.
//
// `authorizeCli(req, action, { type: "project" })` runs before the route knows which project it
// is about, so it can only ask the org-wide question: may this caller `action` projects in this
// org at all? A grant or deny scoped to one project is not part of that answer — the PDP evaluates
// a project-scoped grant only when it is given the project's id (lib/authz/evaluate.ts
// `coversResource`; lib/authz/fga-mapping.ts `checksFor` / `denyChecksFor`). So a route that
// stopped there would answer for the org and not for the project the caller named.
//
// {@link resolveCliProjectAuthorized} is the second half: resolve the project inside the caller's
// org, then ask the same action about THAT project. A route that reaches the project some other way
// — a configuration read by project name, a cluster read by cluster id — asks
// {@link cliMayActOnProject} with the project id it found, and a list of project-owned rows filters
// on {@link cliViewableProjectIds}.
//
// WHAT HOLDS ROUTES TO THIS is tests/app/api/cli/project-routes-addressed.test.ts, and only within
// the boundary its header states: every handler under app/api/cli/ that authorizes the org-wide
// project permission must also call one of these with the same action, except the handlers in its
// exemption ledger (each with its reason), and no file but this one may import `resolveCliProject`.
// A route that reads project-owned rows WITHOUT that org-wide project authorization is outside the
// derived rule — it has to apply these by hand, and the ones found so far are pinned by hand in that
// test's PROJECT_BOUND_HANDLERS: the agent reads, through {@link cliMayViewProjectBoundRow} and
// {@link cliProjectBoundVisibleWhere}, and classification on a project-owned resource, through
// `mayClassifyResource` (lib/classification/resource-project.ts, which asks
// {@link cliMayActOnProject}).
//
// NOT ONLY THE CLI. Nothing here reads the request: every helper takes an `Actor`, so the console's
// server actions that answer the same question (`listAgents` / `getAgent`, the classification
// assignment actions) call these too, and the two surfaces cannot drift apart.

import { type AnyColumn, and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import { enforceDecision } from "@/lib/authz/activity";
import type { Action } from "@/lib/authz/registry";
import { type Actor, ForbiddenError, type ResourceRef } from "@/lib/authz/types";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";

/** A project row as {@link resolveCliProject} returns it. */
type CliProject = NonNullable<Awaited<ReturnType<typeof resolveCliProject>>>;

/**
 * Resolves the project a CLI route addressed (by id, name or slug, within `actor.orgId`) and
 * returns it only when `actor` may `action` THAT project. Returns null otherwise.
 *
 * ONE null for both "no such project in this org" and "not permitted on this project", and every
 * caller answers it with the same `404 {"error":"Project not found"}`: a refusal that read
 * differently from an absence would tell the caller the project exists. The only remaining
 * difference is that an absent project skips the PDP call — a timing signal within the caller's
 * own org, about a project name there.
 *
 * RECORDED ON REFUSAL ONLY. The decision is asked with `can()`; a refusal is then handed to
 * `enforceDecision`, which writes the denial to the activity log and emits it as an action event
 * (so an org's alert rules see it), and whose ForbiddenError is caught here so the route still
 * answers the not-found it answers for an absent project. An allow is not recorded again: the
 * route's `authorizeCli` already recorded the org-level decision for a non-read action, and a
 * second row per allowed request would only be noise. This is the same split `authorizeRead`
 * makes (lib/authz/guard.ts), which cannot be used here because it resolves the actor from the
 * session and throws.
 */
export async function resolveCliProjectAuthorized(
	actor: Actor,
	idOrName: string,
	action: Action,
): Promise<CliProject | null> {
	const project = await resolveCliProject(actor.orgId, idOrName);
	if (!project) return null;
	return (await cliMayActOnProject(actor, project.id, action)) ? project : null;
}

/**
 * True when `actor` may `action` the project `projectId`. A refusal is recorded and emitted (see
 * {@link resolveCliProjectAuthorized}) and answered as `false`, never thrown, so the caller can
 * give it the same not-found it gives an absent row. `projectId` must already be known to belong
 * to `actor.orgId` — this asks about permission, not tenancy.
 */
export async function cliMayActOnProject(
	actor: Actor,
	projectId: string,
	action: Action,
): Promise<boolean> {
	const ref: ResourceRef = { type: "project", id: projectId };
	const decision = await getPdp().can(actor, action, ref);
	if (decision.allowed) return true;
	try {
		enforceDecision(actor, action, ref, decision);
	} catch (err) {
		// The refusal is recorded; its throw is the one part not wanted here.
		if (!(err instanceof ForbiddenError)) throw err;
	}
	return false;
}

/**
 * The ids of the projects in `actor.orgId` that `actor` may view — the PDP's own deny-aware answer
 * (`listAccessible`). A CLI list of project-owned rows filters on it, so a project the caller may
 * not view is absent from the list as well as refused by id.
 */
export async function cliViewableProjectIds(actor: Actor): Promise<string[]> {
	return getPdp().listAccessible(actor, "view", "project");
}

/**
 * For a row that is OWNED by another resource but may name a project (an agent identity's
 * `project_id`): true when `actor` may see it as far as that project is concerned.
 *
 *   - no project → nothing to ask (true);
 *   - a project that is not in `actor.orgId` → not this org's question (true). Such a row reached
 *     the caller through its own tenancy arm (a session's own personal rows), and the deny that
 *     could hide it lives in the org that owns the project;
 *   - a project in `actor.orgId` → {@link cliMayActOnProject} `view`, which records a refusal.
 */
export async function cliMayViewProjectBoundRow(
	actor: Actor,
	projectId: string | null,
): Promise<boolean> {
	if (!projectId) return true;
	const [inOrg] = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.id, projectId), eq(projects.org_id, actor.orgId)))
		.limit(1);
	if (!inOrg) return true;
	return cliMayActOnProject(actor, projectId, "view");
}

/**
 * The list form of {@link cliMayViewProjectBoundRow}, as a predicate on `projectIdColumn`: the row
 * names no project, or a project the caller may view, or a project outside `actor.orgId`. ANDed
 * onto a list's own tenancy predicate; it narrows within it and never widens it.
 */
export async function cliProjectBoundVisibleWhere(
	actor: Actor,
	projectIdColumn: AnyColumn,
): Promise<SQL> {
	const viewable = await cliViewableProjectIds(actor);
	return (
		or(
			isNull(projectIdColumn),
			inArray(projectIdColumn, viewable),
			sql`not exists (select 1 from ${projects} where ${projects.id} = ${projectIdColumn} and ${projects.org_id} = ${actor.orgId})`,
		) ?? sql`false`
	);
}
