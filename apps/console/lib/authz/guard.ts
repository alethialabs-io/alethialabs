// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { getOwnerScope } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import { getInjectedActor } from "@/lib/authz/actor-context";
import type { Action, Resource } from "@/lib/authz/registry";
import { type Actor, ForbiddenError, type ResourceRef } from "@/lib/authz/types";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";

/**
 * Resolves the verified caller into an Actor (identity → active tenancy scope).
 * Use for list views, which then call getPdp().listAccessible(...) for the id-set.
 *
 * An actor bound via runWithActor() (the MCP server's token path) takes precedence
 * over the session — already PDP-scoped, so no re-resolution is needed.
 */
export async function currentActor(): Promise<Actor> {
	const injected = getInjectedActor();
	if (injected) return injected;
	const { userId, activeOrgId } = await getOwnerScope();
	return getActiveScope(userId, activeOrgId);
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

/**
 * Like {@link authorize}, but enforces the permission *without* recording an
 * activity-log entry or emitting an action event (it uses `can()` instead of
 * `enforce()`). For setup / no-op steps that gate on a manage permission but are
 * not themselves user-meaningful events — e.g. seeding a pending cloud identity
 * just to open the connect sheet, which should never show up in the activity feed.
 */
export async function authorizeQuiet(
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<Actor> {
	const actor = await currentActor();
	const ref: ResourceRef = { type: resource.type, id: resource.id };
	const decision = await getPdp().can(actor, action, ref);
	if (!decision.allowed) throw new ForbiddenError(action, ref, decision.reason);
	return actor;
}

function forbidden(): Response {
	return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
}

/** True if `userId` has a `member` row in `orgId` (the personal org — orgId === userId
 *  — is always the user's own, so it needs no membership row). */
async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
	if (orgId === userId) return true;
	const [m] = await getServiceDb()
		.select({ id: member.id })
		.from(member)
		.where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
		.limit(1);
	return Boolean(m);
}

/**
 * Tenancy guard for CLI routes whose path carries an `[id]` org segment: allow only
 * when the resolved scope already targets `orgId`, or the caller is a member of it.
 * Returns a 403 Response to return on denial, or null when access is permitted.
 */
export async function ensureCliOrgAccess(
	actor: Actor,
	userId: string,
	orgId: string,
): Promise<Response | null> {
	if (actor.orgId === orgId) return null;
	if (await isOrgMember(userId, orgId)) return null;
	return forbidden();
}

/**
 * CLI-route authorization: verify the CLI token, resolve the actor, and enforce.
 * Returns `{ actor }` on success or `{ error }` (the Response to return). CLI routes
 * query via getServiceDb() (no RLS), so the caller MUST also scope its query by
 * `actor.orgId` — enforce() is the permission gate, org_id is the tenancy boundary.
 *
 * An optional `X-Alethia-Org` header selects which org the call is scoped to (the CLI
 * `--org` flag). It is honoured only after verifying the caller is a member of that org
 * (else 403); absent, behaviour is identical to resolving the default active scope.
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
	const headerOrg = req.headers.get("X-Alethia-Org")?.trim();
	if (headerOrg && !(await isOrgMember(userId, headerOrg))) {
		return { error: forbidden() };
	}
	const actor = headerOrg
		? await getActiveScope(userId, headerOrg)
		: await getActiveScope(userId);
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
