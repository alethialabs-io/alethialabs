// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared authorization audit + enforcement, used by BOTH PDP engines (the community
// PostgresRbacPDP and the enterprise OpenFgaPdp), so the access log is engine-agnostic
// and a single ForbiddenError class flows to the call-site guards.

import { emitActionEvent } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import { authzAuditLog } from "@/lib/db/schema";
import type { Action } from "@/lib/authz/registry";
import {
	type Actor,
	type Decision,
	ForbiddenError,
	type ResourceRef,
} from "@/lib/authz/types";

// Actions always audited on ALLOW (denials are always audited). Keeps the log
// meaningful without a row per read — the spec's sensitive-action set.
export const SENSITIVE: ReadonlySet<Action> = new Set<Action>([
	"destroy",
	"manage_identities",
	"manage_members",
	"manage_connectors",
	"manage_billing",
	"export_audit",
]);

/** Fire-and-forget decision record; never blocks the request. */
export function writeAuthzAudit(
	actor: Actor,
	action: Action,
	resource: ResourceRef,
	decision: boolean,
	reason?: string,
): void {
	void getServiceDb()
		.insert(authzAuditLog)
		.values({
			org_id: actor.orgId,
			actor_id: actor.userId,
			action,
			resource_type: resource.type,
			resource_id: resource.id ?? null,
			decision,
			reason: reason ?? null,
		})
		.catch((err) => console.error("[authz] audit write failed:", err));
}

/**
 * Records a decision and enforces it: audits every denial (and sensitive allows),
 * then throws `ForbiddenError` on deny. The single enforce path for both engines.
 */
export function enforceDecision(
	actor: Actor,
	action: Action,
	resource: ResourceRef,
	decision: Decision,
): void {
	if (!decision.allowed) {
		writeAuthzAudit(actor, action, resource, false, decision.reason);
		// Universal action seam: every PDP decision is alertable by config. A cached
		// no-op unless the org has a rule whose pattern matches this event key.
		emitActionEvent(actor, action, resource, false);
		throw new ForbiddenError(action, resource, decision.reason);
	}
	if (SENSITIVE.has(action)) writeAuthzAudit(actor, action, resource, true);
	emitActionEvent(actor, action, resource, true);
}
