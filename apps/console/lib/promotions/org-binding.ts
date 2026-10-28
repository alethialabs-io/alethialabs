// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, eq } from "drizzle-orm";
import { ActionRefusal } from "@/lib/actions/result";
import { authorize, authorizeRead, currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { environmentPromotions, projects } from "@/lib/db/schema";
import type { PromotionRow } from "@/lib/promotions/lifecycle";

// THE ORG BINDING OF THE ENVIRONMENTS DOMAIN'S ID-ADDRESSED READS AND WRITES (#6225, #6120).
//
// The PDP's `can()` answers for an org-wide grant without asking which organization a resource id
// belongs to: `view` on `{ type: "project", id }` holds for ANY project id once the actor has the
// grant org-wide. So a read or write addressed by a project or promotion id binds that id to the
// actor's organization HERE, before anything else is read, and an id of another organization is
// reported exactly like an id that does not exist.
//
// It lives in an ordinary module rather than in a `"use server"` file: every export of one of those
// is a callable server action, and these helpers are called by both the read procedures
// (`lib/rpc/procedures/environments.ts`) and the write actions (`app/server/actions/promotions.ts`,
// `app/server/actions/protection.ts`).

/** The refusal an id outside the addressed organization (or no id at all) is reported as. */
const PROMOTION_NOT_FOUND = "Promotion not found";

/**
 * Throws a `not-found` refusal unless `projectId` is a project of `actor`'s organization. The read
 * is on the service role, so the `projects.org_id` predicate IS the tenancy wall.
 */
export async function assertProjectInActorOrg(actor: Actor, projectId: string): Promise<void> {
	const [row] = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.id, projectId), eq(projects.org_id, actor.orgId)))
		.limit(1);
	if (!row) throw new ActionRefusal("not-found", "Project not found.");
}

/**
 * Resolves a promotion WITHIN the addressed organization, then authorizes the caller for its project.
 *
 * The promotion is read on the service role, so the org predicate here is the tenancy wall: the
 * project's `org_id` must be the actor's org. A promotion of any other organization is reported
 * exactly like an id that does not exist, and the PDP is never asked about its project — an org-wide
 * grant matches any project id, so asking it would answer for a project this org does not own.
 * The project's org is the source of truth (`environment_promotions.org_id` is nullable).
 *
 * `view` is asked with `authorizeRead` — quiet when allowed, recorded once when refused — because the
 * Environments overview reads the in-flight promotion on every live refresh. `deploy` is a write and
 * keeps `authorize`, which records the allowed decision too.
 */
export async function promotionInActorOrg(
	promotionId: string,
	action: "view" | "deploy",
): Promise<{ actor: Actor; promotion: PromotionRow; orgId: string }> {
	const scope = await currentActor();
	const [row] = await getServiceDb()
		.select({ promotion: environmentPromotions, orgId: projects.org_id })
		.from(environmentPromotions)
		.innerJoin(projects, eq(projects.id, environmentPromotions.project_id))
		.where(and(eq(environmentPromotions.id, promotionId), eq(projects.org_id, scope.orgId)))
		.limit(1);
	if (!row?.orgId) throw new ActionRefusal("not-found", PROMOTION_NOT_FOUND);
	const projectId = row.promotion.project_id;
	const actor =
		action === "view"
			? await authorizeRead("view", { type: "project", id: projectId })
			: await authorize(action, { type: "project", id: projectId });
	// `authorize` resolves the actor again; it must be the same organization the row was bound to.
	if (actor.orgId !== row.orgId) throw new ActionRefusal("not-found", PROMOTION_NOT_FOUND);
	return { actor, promotion: row.promotion, orgId: row.orgId };
}
