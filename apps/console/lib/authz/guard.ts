// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireOwner } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import type { Action, Resource } from "@/lib/authz/registry";
import type { Actor, ResourceRef } from "@/lib/authz/types";

/**
 * Resolves the verified caller into an Actor (identity → active tenancy scope).
 * Use for list views, which then call getPdp().listAccessible(...) for the id-set.
 */
export async function currentActor(): Promise<Actor> {
	return getActiveScope(await requireOwner());
}

/**
 * The single authorization entry point for server actions / routes: resolve the
 * actor and enforce `action` on `resource` (throws ForbiddenError → 403 on deny).
 * Returns the actor so the caller can scope its query (actor.userId for
 * withOwnerScope). Replaces ad-hoc `.eq(user_id)` ownership checks.
 */
export async function authorize(
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<Actor> {
	const actor = await currentActor();
	const ref: ResourceRef = { type: resource.type, id: resource.id };
	await getPdp().enforce(actor, action, ref);
	return actor;
}
