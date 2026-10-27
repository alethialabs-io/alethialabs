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
// org, then ask the same action about THAT project. The routes under
// `app/api/cli/projects/[id]/` reach a project only through it (or through `resolveByoScope`,
// which calls it). A route that reaches the project some other way — a configuration read by
// project name, a cluster read by cluster id — asks {@link cliMayActOnProject} with the project id
// it found. tests/app/api/cli/project-routes-addressed.test.ts holds them to that.

import { getPdp } from "@/lib/authz";
import { enforceDecision } from "@/lib/authz/activity";
import type { Action } from "@/lib/authz/registry";
import { type Actor, ForbiddenError, type ResourceRef } from "@/lib/authz/types";
import { resolveCliProject } from "@/lib/cli/resolve-project";

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
	void enforceDecision;
	void ForbiddenError;
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
