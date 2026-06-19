// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { requireOwner } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import type { Action, Resource } from "@/lib/authz/registry";
import { type Actor, ForbiddenError, type ResourceRef } from "@/lib/authz/types";
import { verifyCliToken } from "@/lib/cli/auth";

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

function forbidden(): Response {
	return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
}

/**
 * CLI-route authorization: verify the CLI token, resolve the actor, and enforce.
 * Returns `{ actor }` on success or `{ error }` (the Response to return). CLI routes
 * query via getServiceDb() (no RLS), so the caller MUST also scope its query by
 * `actor.orgId` — enforce() is the permission gate, org_id is the tenancy boundary.
 */
export async function authorizeCli(
	req: Request,
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<{ actor: Actor } | { error: Response }> {
	const { payload, error } = await verifyCliToken(req);
	if (error) return { error };
	const userId = payload?.sub;
	if (!userId) {
		return {
			error: new Response(JSON.stringify({ error: "Invalid token payload" }), {
				status: 400,
			}),
		};
	}
	const actor = await getActiveScope(userId);
	try {
		await getPdp().enforce(actor, action, { type: resource.type, id: resource.id });
	} catch (e) {
		if (e instanceof ForbiddenError) return { error: forbidden() };
		throw e;
	}
	return { actor };
}

/**
 * Enforces `action` on `resource` for an already-resolved userId (e.g. provider
 * routes that authenticated via resolveCliProvider). Returns a 403 Response on
 * denial, or null when allowed. Callers that also need explicit org scoping should
 * resolve the actor via getActiveScope (or use authorizeCli, which returns it).
 */
export async function authorizeUserId(
	userId: string,
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<Response | null> {
	const actor = await getActiveScope(userId);
	try {
		await getPdp().enforce(actor, action, { type: resource.type, id: resource.id });
	} catch (e) {
		if (e instanceof ForbiddenError) return forbidden();
		throw e;
	}
	return null;
}
