// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The authorization contract (spec/mvp/07-auth-rbac-sso.md Part B). One Policy
// Decision Point (PDP) interface backs every access decision; the engine behind it
// is swappable (community PostgresRbacPDP → enterprise OpenFgaPDP) with no call-site
// changes. Resource/Action are exhaustive unions (registry.ts) so a new capability
// is a single typed edit.

import type { Action, Resource } from "./registry";

/** The principal making a request, resolved once per request via getActiveScope(). */
export interface Actor {
	userId: string;
	/** Active tenancy scope. Community = the user's personal org (orgId === userId). */
	orgId: string;
}

/** What an action targets. `id` is omitted for create/list; `orgId` for cross-checks. */
export interface ResourceRef {
	type: Resource;
	id?: string;
	/** The org that owns the resource (for the coarse scope check). */
	orgId?: string;
}

export interface Decision {
	allowed: boolean;
	/** Machine-readable reason (logged to authz_audit_log), e.g. "no_grant". */
	reason?: string;
}

export interface BulkCheck {
	action: Action;
	resource: ResourceRef;
}

/**
 * The single place an access decision is made. Call sites use `enforce()` (throws
 * 403) or `listAccessible()` (the ListObjects equivalent for list views) — never
 * their own `.eq(user_id)` checks. `bulkCheck` batches; never loop `can()`.
 */
export interface Pdp {
	can(actor: Actor, action: Action, resource: ResourceRef): Promise<Decision>;
	enforce(actor: Actor, action: Action, resource: ResourceRef): Promise<void>;
	bulkCheck(actor: Actor, checks: BulkCheck[]): Promise<Decision[]>;
	/** The ids of resources of `resourceType` the actor may take `action` on. */
	listAccessible(
		actor: Actor,
		action: Action,
		resourceType: Resource,
	): Promise<string[]>;
}

/** Feature entitlements for a scope. Community = all false; ee/ flips per license. */
export interface Entitlements {
	organizations: boolean;
	sso: boolean;
	customRoles: boolean;
	auditExport: boolean;
}

/** Thrown by enforce() on denial; mapped to 403 at route/action boundaries. */
export class ForbiddenError extends Error {
	constructor(
		readonly action: Action,
		readonly resource: ResourceRef,
		readonly reason?: string,
	) {
		super(
			`Forbidden: ${action} on ${resource.type}${resource.id ? ` ${resource.id}` : ""}${reason ? ` (${reason})` : ""}`,
		);
		this.name = "ForbiddenError";
	}
}
