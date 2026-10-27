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
// which calls it), and tests/app/api/cli/project-routes-addressed.test.ts holds them to that.

import { getPdp } from "@/lib/authz";
import type { Action } from "@/lib/authz/registry";
import type { Actor } from "@/lib/authz/types";
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
 * Asked with `can()`, not `enforce()`: the route's own `authorizeCli` already recorded the
 * attempt, and this narrows that decision to one project rather than making a second one.
 */
export async function resolveCliProjectAuthorized(
	actor: Actor,
	idOrName: string,
	action: Action,
): Promise<CliProject | null> {
	const project = await resolveCliProject(actor.orgId, idOrName);
	if (!project) return null;
	const decision = await getPdp().can(actor, action, {
		type: "project",
		id: project.id,
	});
	return decision.allowed ? project : null;
}
