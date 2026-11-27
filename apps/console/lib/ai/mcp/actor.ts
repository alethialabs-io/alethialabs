// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The actor an MCP access token acts as (agent surface §4.4): the person the token was issued to,
// in the organization the grant was given in, held to a ceiling of the token's scopes ∩ the grant's
// scopes and the grant's project list ∩ the URL's `?project=` pin — and refused outright while the
// organization's agent access (the kill switch) is off.
//
// The grant is read on EVERY request (lib/agents/grant-binding.ts), so a disconnect binds the very
// next request: the access token is a JWT that stays verifiable until it expires, and only this read
// knows it was withdrawn.
//
// The ceiling is applied by the PDP that `getPdp` returns (lib/authz/scope-ceiling.ts), so every tool
// the server lists, and every in-app read a declared read answers through, is held to it; the MCP server also checks each
// declared tool's scope before it runs (lib/ai/mcp/server.ts).

import "server-only";
import { type GrantBinding, readGrantBinding, releaseUngrantedConsent } from "@/lib/agents/grant-binding";
import { readAgentPolicy } from "@/lib/approvals/context";
import type { AgentScope } from "@/lib/approvals/types";
import { ceilingFromAccessTokenClaims } from "@/lib/auth/mcp-scopes";
import { getActiveScope } from "@/lib/auth/scope";
import { actorWithCredential } from "@/lib/authz/actor-credential";
import type { Actor, ResolvedScope } from "@/lib/authz/types";
import { withScope } from "@/lib/db";

/** Why a token was not resolved into an actor. */
export type McpActorRefusal =
	/** The token names no person. */
	| "no_subject"
	/** The token names no OAuth client, so no consent grant can be read for it. */
	| "no_client"
	/** Every consent grant the person gave this client is revoked: the connection was disconnected. */
	| "grant_revoked"
	/**
	 * No grant was recorded for this client: a consent record without one, or neither a consent nor a
	 * grant for a client that is not marked to skip consent.
	 */
	| "grant_missing"
	/** The token carries no agent scope this server reads, or none the grant leaves. */
	| "insufficient_scope"
	/** The grant names no organization, or one the person is not an active member of any more. */
	| "org_not_permitted"
	/** The URL pins a project the grant does not cover, or the grant covers no project at all. */
	| "project_not_permitted"
	/** The organization's agent access is turned off. */
	| "agent_access_disabled";

/** The actor, or why there is none. */
export type McpActorResolution = { ok: true; actor: Actor } | { ok: false; reason: McpActorRefusal };

/** What resolving reads, so tests can stand each one in. */
export interface McpActorDeps {
	/** The person's grant to OAuth client `clientId`: live, all revoked, consent without one, neither, or none for a skip-consent client. */
	readGrant(userId: string, clientId: string): Promise<GrantBinding>;
	/** Returns a consent that has no grant to the consent screen on the client's next authorization. */
	releaseUngrantedConsent(userId: string, clientId: string): Promise<void>;
	/** The person's tenancy scope, preferring `orgId` when it is given. */
	resolveScope(userId: string, orgId?: string): Promise<ResolvedScope>;
	/** False while the organization's agent kill switch is off. */
	agentAccessEnabled(scope: { userId: string; orgId: string }): Promise<boolean>;
}

/** The default reads. */
export const defaultMcpActorDeps: McpActorDeps = {
	readGrant: readGrantBinding,
	releaseUngrantedConsent,
	resolveScope: getActiveScope,
	agentAccessEnabled: async (scope) =>
		(await withScope({ ownerId: scope.userId, orgId: scope.orgId }, (tx) => readAgentPolicy(tx, scope.orgId)))
			.agentAccessEnabled,
};

/** The OAuth client a token was issued to: its `azp` claim, else `client_id`; null when neither is set. */
export function clientIdFromClaims(claims: { azp?: unknown; client_id?: unknown }): string | null {
	for (const value of [claims.azp, claims.client_id]) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/**
 * Resolves verified access-token `claims` into the actor the MCP request runs as, with `projectPin`
 * the URL's `?project=` value. Fails closed at every step: a token with no subject, no readable agent
 * scope or no client; a client whose every grant is revoked; a consent recorded without a grant;
 * neither a consent nor a grant for a client not marked to skip consent; a live grant with no organization, an
 * organization the person is not an active member of, or no project; a pin outside the grant; or an
 * organization whose agent access is off — each yields no actor.
 *
 * With a live grant the actor acts in the grant's organization ONLY (never the person's default),
 * with the token's scopes narrowed to the grant's and its projects to the grant's list. Only for a
 * client marked `skip_consent` (no consent screen, so no grant is ever written) does a token with no
 * grant row act as before: the person's resolved org, the token's scopes, every project.
 *
 * The actor is bound as `agent_oauth`, with the OAuth client as its credential reference, so an
 * approval one client requested can be used by that client only (lib/approvals/gate.ts).
 */
export async function resolveMcpActor(
	claims: { sub?: unknown; scope?: unknown; azp?: unknown; client_id?: unknown },
	projectPin: string | null,
	deps: McpActorDeps = defaultMcpActorDeps,
): Promise<McpActorResolution> {
	const subject = claims.sub;
	if (typeof subject !== "string" || subject.length === 0) return { ok: false, reason: "no_subject" };
	// The token's own ceiling, read once: no agent scope is a refusal before any grant is read.
	const ceiling = ceilingFromAccessTokenClaims(claims, null);
	if (!ceiling) return { ok: false, reason: "insufficient_scope" };
	// Every access token the provider issues names its client (`azp`); one that does not cannot be
	// matched to a grant, and "no grant" is the widest answer there is, so it is a refusal.
	const clientId = clientIdFromClaims(claims);
	if (!clientId) return { ok: false, reason: "no_client" };

	const binding = await deps.readGrant(subject, clientId);
	if (binding.kind === "revoked") return { ok: false, reason: "grant_revoked" };
	if (binding.kind === "ungranted") {
		// A consent with no grant recorded names no org, scopes or projects: nothing to act within, and
		// the no-grant path below is the widest answer there is. Releasing the consent sends the
		// client's next authorization back to the consent screen; the refusal stands either way.
		await deps.releaseUngrantedConsent(subject, clientId).catch(() => undefined);
		return { ok: false, reason: "grant_missing" };
	}
	// Neither a consent nor a grant, for a client that shows the consent screen: the consent the token
	// was issued under is gone, and nothing names an org, scopes or projects. Nothing to release; the
	// client's next authorization finds no consent and shows the consent screen.
	if (binding.kind === "unconsented") return { ok: false, reason: "grant_missing" };

	let scope: ResolvedScope;
	let grantScopes: readonly AgentScope[] | null = null;
	let grantProjects: readonly string[] | null = null;
	if (binding.kind === "live") {
		const { grant } = binding;
		if (grant.orgId.length === 0) return { ok: false, reason: "org_not_permitted" };
		if (grant.projectIds !== null && grant.projectIds.length === 0) {
			return { ok: false, reason: "project_not_permitted" };
		}
		scope = await deps.resolveScope(subject, grant.orgId);
		// The scope resolver treats its org as a preference and falls back to another org (or the
		// personal one) when the person is not an active member; a grant names one org, so anything
		// else is a refusal, not a fallback.
		if (scope.orgId !== grant.orgId) return { ok: false, reason: "org_not_permitted" };
		grantScopes = grant.scopes;
		grantProjects = grant.projectIds;
	} else {
		scope = await deps.resolveScope(subject);
	}

	const allowed = grantScopes;
	const scopes = allowed === null ? ceiling.scopes : ceiling.scopes.filter((s) => allowed.includes(s));
	if (scopes.length === 0) return { ok: false, reason: "insufficient_scope" };
	// The grant's projects (never empty: refused above), or every project when there is no grant.
	let projectIds: readonly string[] | null = grantProjects === null ? null : [...grantProjects];

	if (projectPin !== null) {
		if (projectIds !== null && !projectIds.includes(projectPin)) {
			return { ok: false, reason: "project_not_permitted" };
		}
		projectIds = [projectPin];
	}

	const actor: Actor = {
		...actorWithCredential(scope, "agent_oauth"),
		ceiling: { scopes, projectIds },
		credentialRef: clientId,
	};
	if (!(await deps.agentAccessEnabled(actor))) return { ok: false, reason: "agent_access_disabled" };
	return { ok: true, actor };
}
