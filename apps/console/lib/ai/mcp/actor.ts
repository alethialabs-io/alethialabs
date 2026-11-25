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
// the server lists, the in-app read tools included, is held to it; the MCP server also checks each
// declared tool's scope before it runs (lib/ai/mcp/server.ts).

import "server-only";
import { type GrantBinding, readGrantBinding } from "@/lib/agents/grant-binding";
import { readAgentPolicy } from "@/lib/approvals/context";
import type { AgentScope } from "@/lib/approvals/types";
import { agentScopesFromClaims, ceilingFromAccessTokenClaims } from "@/lib/auth/mcp-scopes";
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
	/** The person's grant to OAuth client `clientId`: live, all revoked, or never written. */
	readGrant(userId: string, clientId: string): Promise<GrantBinding>;
	/** The person's tenancy scope, preferring `orgId` when it is given. */
	resolveScope(userId: string, orgId?: string): Promise<ResolvedScope>;
	/** False while the organization's agent kill switch is off. */
	agentAccessEnabled(scope: { userId: string; orgId: string }): Promise<boolean>;
}

/** The default reads. */
export const defaultMcpActorDeps: McpActorDeps = {
	readGrant: readGrantBinding,
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
 * scope or no client; a client whose every grant is revoked; a live grant with no organization, an
 * organization the person is not an active member of, or no project; a pin outside the grant; or an
 * organization whose agent access is off — each yields no actor.
 *
 * With a live grant the actor acts in the grant's organization ONLY (never the person's default),
 * with the token's scopes narrowed to the grant's and its projects to the grant's list. With no grant
 * row at all (a token from before consent grants) it acts as before: the person's resolved org, the
 * token's scopes, every project.
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
	if (!agentScopesFromClaims(claims).ok) return { ok: false, reason: "insufficient_scope" };
	// Every access token the provider issues names its client (`azp`); one that does not cannot be
	// matched to a grant, and "no grant" is the widest answer there is, so it is a refusal.
	const clientId = clientIdFromClaims(claims);
	if (!clientId) return { ok: false, reason: "no_client" };

	const binding = await deps.readGrant(subject, clientId);
	if (binding.kind === "revoked") return { ok: false, reason: "grant_revoked" };

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

	const tokenCeiling = ceilingFromAccessTokenClaims(claims, grantProjects);
	if (!tokenCeiling) return { ok: false, reason: "insufficient_scope" };
	const allowed = grantScopes;
	const scopes = allowed === null ? tokenCeiling.scopes : tokenCeiling.scopes.filter((s) => allowed.includes(s));
	if (scopes.length === 0) return { ok: false, reason: "insufficient_scope" };
	let projectIds = tokenCeiling.projectIds;

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
