// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared Activity recording + authorization enforcement, used by BOTH PDP engines (the
// community PostgresRbacPDP and the enterprise OpenFgaPdp), so the Activity log is
// engine-agnostic and a single ForbiddenError flows to the call-site guards.
//
// What's recorded: every DENIAL, and every successful action that ISN'T a pure read
// (READ_ONLY) — so the log captures all mutations without a row per page view. Actions
// that don't flow through the PDP (custom roles, access grants, member lifecycle) call
// `recordActivity` directly. Personal-scope mutations (agent threads, provider-token
// unlink) are intentionally NOT logged here — they aren't org activity.

import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { emitActionEvent } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, cloudIdentities, projects, role, runners } from "@/lib/db/schema";
import type { Action } from "@/lib/authz/registry";
import {
	type ResolvedScope,
	type Decision,
	ForbiddenError,
	type ResourceRef,
} from "@/lib/authz/types";
import { log } from "@/lib/observability/log";

// Successful reads are not recorded (they fire on every page load and would flood the
// log); their DENIALS still are. Everything else is recorded on allow.
const READ_ONLY: ReadonlySet<string> = new Set([
	"view",
	"view_activity",
	"view_alerts",
]);

/**
 * The resource's current display name as a scalar subquery, for the resource types that have one
 * and are not a person (#6735) — or `null` when the type carries no name here.
 *
 * Evaluated INSIDE the insert, so it costs no round trip and the write stays fire-and-forget. Every
 * lookup is scoped to `orgId` (the actor's org — the row's own `org_id`): a DENIED attempt on
 * another org's resource id must not copy that org's name into this org's log. A built-in role has
 * no organization and its name is the registry's, so it is the one exception to that scope.
 *
 * Members and invitations are deliberately absent: their names are personal data and this table is
 * WORM, so a copy could never be erased (lib/privacy/erasure-plan.ts).
 */
function liveNameOf(orgId: string, type: string, id: string): SQL | null {
	switch (type) {
		case "project":
			return sql`(select ${projects.project_name} from ${projects} where ${and(eq(projects.id, id), eq(projects.org_id, orgId))})`;
		case "runner":
			return sql`(select ${runners.name} from ${runners} where ${and(eq(runners.id, id), eq(runners.org_id, orgId))})`;
		case "cloud_identity":
			return sql`(select ${cloudIdentities.name} from ${cloudIdentities} where ${and(eq(cloudIdentities.id, id), eq(cloudIdentities.org_id, orgId))})`;
		case "role":
			return sql`(select ${role.name} from ${role} where ${and(eq(role.id, id), or(eq(role.organization_id, orgId), isNull(role.organization_id)))})`;
		default:
			return null;
	}
}

/**
 * Fire-and-forget Activity record; never blocks the request. Free-form `action`/`type`
 * so non-registry governance events (role / grant / member) can be logged alongside the
 * PDP-enforced ones. `decision` defaults to true (an allowed action).
 *
 * The resource's display name is recorded WITH the event (#6735), so the line still names the
 * thing once it is gone. `opts.resourceName` is the caller's own copy and wins; a caller recording
 * a deletion AFTER the row is gone must pass it, because the fallback — the resource's current
 * name, read in the same statement ({@link liveNameOf}) — can no longer find it.
 */
export function recordActivity(
	actor: ResolvedScope,
	action: string,
	resource: { type: string; id?: string | null },
	opts?: { decision?: boolean; reason?: string; resourceName?: string | null },
): void {
	const resourceId = resource.id ?? null;
	const resourceName =
		opts?.resourceName ??
		(resourceId ? liveNameOf(actor.orgId, resource.type, resourceId) : null);
	void getServiceDb()
		.insert(authzActivityLog)
		.values({
			org_id: actor.orgId,
			actor_id: actor.userId,
			action,
			resource_type: resource.type,
			resource_id: resourceId,
			resource_name: resourceName,
			decision: opts?.decision ?? true,
			reason: opts?.reason ?? null,
		})
		.catch((err) => log.error("[authz] activity write failed", { err }));
}

/**
 * Records an ALLOWED action after it has happened, and emits it as an action event — the half of
 * {@link enforceDecision} that a caller using `authorizeDeferred` (lib/authz/guard.ts) owes once
 * its operation succeeded. `resourceName` is for a resource the operation just created (its id did
 * not exist at the check) or just deleted (its row is gone now).
 */
export function recordAllowed(
	actor: ResolvedScope,
	action: Action,
	resource: ResourceRef,
	opts?: { resourceName?: string | null; recordAs?: string },
): void {
	recordActivity(actor, opts?.recordAs ?? action, resource, {
		resourceName: opts?.resourceName,
	});
	emitActionEvent(actor, action, resource, true);
}

/**
 * Records a decision and enforces it: records every denial and every non-read allow,
 * then throws `ForbiddenError` on deny. The single enforce path for both engines.
 */
export function enforceDecision(
	actor: ResolvedScope,
	action: Action,
	resource: ResourceRef,
	decision: Decision,
): void {
	if (!decision.allowed) {
		recordActivity(actor, action, resource, {
			decision: false,
			reason: decision.reason,
		});
		// Universal action seam: every PDP decision is alertable by config. A cached
		// no-op unless the org has a rule whose pattern matches this event key.
		emitActionEvent(actor, action, resource, false);
		throw new ForbiddenError(action, resource, decision.reason);
	}
	if (!READ_ONLY.has(action)) recordActivity(actor, action, resource);
	emitActionEvent(actor, action, resource, true);
}
