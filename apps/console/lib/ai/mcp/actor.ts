// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The actor an MCP access token acts as (agent surface §4.4): the person the token was issued to,
// in the organization the grant was given in, held to a ceiling of the token's scopes ∩ the grant's
// scopes and the grant's project list ∩ the URL's `?project=` pin — and refused outright while the
// organization's agent access (the kill switch) is off.
//
// The ceiling is applied by the PDP that `getPdp` returns (lib/authz/scope-ceiling.ts), so every tool
// the server lists, and every in-app read a declared read answers through, is held to it; the MCP server also checks each
// declared tool's scope before it runs (lib/ai/mcp/server.ts).

import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { readAgentPolicy } from "@/lib/approvals/context";
import type { AgentScope } from "@/lib/approvals/types";
import { ceilingFromAccessTokenClaims } from "@/lib/auth/mcp-scopes";
import { getActiveScope } from "@/lib/auth/scope";
import { actorWithCredential } from "@/lib/authz/actor-credential";
import type { Actor, ResolvedScope } from "@/lib/authz/types";
import { getServiceDb, withScope } from "@/lib/db";
import { agentOauthGrants } from "@/lib/db/schema";

/** What a person's MCP consent narrowed the agent to (`agent_oauth_grants`). */
export interface AgentGrant {
	orgId: string;
	scopes: readonly AgentScope[];
	/** Null: every project in the org. */
	projectIds: readonly string[] | null;
}

/** Why a token was not resolved into an actor. */
export type McpActorRefusal =
	/** The token names no person. */
	| "no_subject"
	/** The token carries no agent scope this server reads, or none the grant leaves. */
	| "insufficient_scope"
	/** The grant's organization is not one the person belongs to any more. */
	| "org_not_permitted"
	/** The URL pins a project the grant does not cover. */
	| "project_not_permitted"
	/** The organization's agent access is turned off. */
	| "agent_access_disabled";

/** The actor, or why there is none. */
export type McpActorResolution = { ok: true; actor: Actor } | { ok: false; reason: McpActorRefusal };

/** What resolving reads, so tests can stand each one in. */
export interface McpActorDeps {
	/** The person's live grant to OAuth client `clientId`, or null when there is none. */
	readGrant(userId: string, clientId: string): Promise<AgentGrant | null>;
	/** The person's tenancy scope, preferring `orgId` when it is given. */
	resolveScope(userId: string, orgId?: string): Promise<ResolvedScope>;
	/** False while the organization's agent kill switch is off. */
	agentAccessEnabled(scope: { userId: string; orgId: string }): Promise<boolean>;
}

/** The default reads. */
export const defaultMcpActorDeps: McpActorDeps = {
	readGrant: async (userId, clientId) => {
		// Read before any actor exists, so through the service connection; the verified token's own
		// subject and client are the predicate, and a revoked grant is never read.
		const [row] = await getServiceDb()
			.select({
				org_id: agentOauthGrants.org_id,
				scopes: agentOauthGrants.scopes,
				project_ids: agentOauthGrants.project_ids,
			})
			.from(agentOauthGrants)
			.where(
				and(
					eq(agentOauthGrants.user_id, userId),
					eq(agentOauthGrants.client_id, clientId),
					isNull(agentOauthGrants.revoked_at),
				),
			)
			.orderBy(desc(agentOauthGrants.updated_at))
			.limit(1);
		return row ? { orgId: row.org_id, scopes: row.scopes, projectIds: row.project_ids } : null;
	},
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
 * the URL's `?project=` value. Fails closed at every step: a token with no subject or no readable
 * agent scope, a grant whose organization the person has left, a pin outside the grant, or an
 * organization whose agent access is off, yields no actor.
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
	const tokenCeiling = ceilingFromAccessTokenClaims(claims);
	if (!tokenCeiling) return { ok: false, reason: "insufficient_scope" };

	const clientId = clientIdFromClaims(claims);
	const grant = clientId ? await deps.readGrant(subject, clientId) : null;

	let scope: ResolvedScope;
	let scopes: readonly AgentScope[] = tokenCeiling.scopes;
	let projectIds: readonly string[] | null = tokenCeiling.projectIds;
	if (grant) {
		scope = await deps.resolveScope(subject, grant.orgId);
		// The scope resolver treats its org as a preference and falls back to another org; a grant
		// names one org, so anything else is a refusal, not a fallback (see resolveNamedOrgScope).
		if (scope.orgId !== grant.orgId) return { ok: false, reason: "org_not_permitted" };
		scopes = scopes.filter((s) => grant.scopes.includes(s));
		if (scopes.length === 0) return { ok: false, reason: "insufficient_scope" };
		projectIds = grant.projectIds;
	} else {
		scope = await deps.resolveScope(subject);
	}

	if (projectPin !== null) {
		if (projectIds !== null && !projectIds.includes(projectPin)) {
			return { ok: false, reason: "project_not_permitted" };
		}
		projectIds = [projectPin];
	}

	const actor: Actor = {
		...actorWithCredential(scope, "agent_oauth"),
		ceiling: { scopes, projectIds },
		...(clientId ? { credentialRef: clientId } : {}),
	};
	if (!(await deps.agentAccessEnabled(actor))) return { ok: false, reason: "agent_access_disabled" };
	return { ok: true, actor };
}
