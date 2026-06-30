// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

import { emitActionEvent } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog } from "@/lib/db/schema";
import type { Action } from "@/lib/authz/registry";
import {
	type Actor,
	type Decision,
	ForbiddenError,
	type ResourceRef,
} from "@/lib/authz/types";

// Successful reads are not recorded (they fire on every page load and would flood the
// log); their DENIALS still are. Everything else is recorded on allow.
const READ_ONLY: ReadonlySet<string> = new Set([
	"view",
	"view_activity",
	"view_alerts",
]);

/**
 * Fire-and-forget Activity record; never blocks the request. Free-form `action`/`type`
 * so non-registry governance events (role / grant / member) can be logged alongside the
 * PDP-enforced ones. `decision` defaults to true (an allowed action).
 */
export function recordActivity(
	actor: Actor,
	action: string,
	resource: { type: string; id?: string | null },
	opts?: { decision?: boolean; reason?: string },
): void {
	void getServiceDb()
		.insert(authzActivityLog)
		.values({
			org_id: actor.orgId,
			actor_id: actor.userId,
			action,
			resource_type: resource.type,
			resource_id: resource.id ?? null,
			decision: opts?.decision ?? true,
			reason: opts?.reason ?? null,
		})
		.catch((err) => console.error("[authz] activity write failed:", err));
}

/**
 * Records a decision and enforces it: records every denial and every non-read allow,
 * then throws `ForbiddenError` on deny. The single enforce path for both engines.
 */
export function enforceDecision(
	actor: Actor,
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
