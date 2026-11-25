// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The OAuth scopes of the MCP authorization server (agent surface §4.4): the scope list `mcp()`
// declares, and the reading of an access token's `scope` claim into the actor's ceiling.
//
// Runtime-light on purpose: lib/auth/index.ts imports it while Better Auth is being built.

import { AGENT_SCOPES, type AgentScope } from "@/lib/approvals/types";
import type { ScopeCeiling } from "@/lib/authz/types";
import { isEnumMember } from "@/lib/coerce";

/** The OpenID Connect scopes the provider keeps serving: its own defaults before agent scopes. */
export const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * Every scope the MCP authorization server declares (`scopes` on `mcp()`): the OpenID Connect
 * scopes, then the five agent scopes. A client may request any subset; the access token's `scope`
 * claim carries what was granted.
 */
export const MCP_PROVIDER_SCOPES: string[] = [...OIDC_SCOPES, ...AGENT_SCOPES];

/** What reading an access token's scopes found. */
export type McpScopeReading =
	| { ok: true; scopes: AgentScope[] }
	| { ok: false; reason: "no_scope" | "unknown_scope" };

/**
 * Reads the agent scopes from an access token's claims. The `scope` claim is the RFC 9068
 * space-separated string.
 *
 * Fails closed:
 * - no `scope` claim, or one that is not a string, or one with no agent scope: `no_scope`;
 * - any value that is neither an OpenID Connect scope nor an agent scope: `unknown_scope` — the
 *   provider declares only those, so anything else is a token this server did not issue as read.
 */
export function agentScopesFromClaims(claims: { scope?: unknown }): McpScopeReading {
	const raw = claims.scope;
	if (typeof raw !== "string") return { ok: false, reason: "no_scope" };
	const scopes: AgentScope[] = [];
	for (const value of raw.split(" ")) {
		if (value === "") continue;
		if (isEnumMember(value, OIDC_SCOPES)) continue;
		if (!isEnumMember(value, AGENT_SCOPES)) return { ok: false, reason: "unknown_scope" };
		if (!scopes.includes(value)) scopes.push(value);
	}
	return scopes.length > 0 ? { ok: true, scopes } : { ok: false, reason: "no_scope" };
}

/**
 * The ceiling an MCP access token carries, or `null` when its scopes cannot be read (see
 * {@link agentScopesFromClaims}) or the project list is empty; a `null` is a refusal.
 *
 * `projectIds` is the consent grant's project list (`agent_oauth_grants.project_ids`), and `null`
 * means every project in the org — what a grant without a project choice, and a token with no grant
 * row at all, carry. It is required so that no caller can drop the grant's projects by omission.
 */
export function ceilingFromAccessTokenClaims(
	claims: { scope?: unknown },
	projectIds: readonly string[] | null,
): ScopeCeiling | null {
	const reading = agentScopesFromClaims(claims);
	if (!reading.ok) return null;
	// ScopeCeiling.projectIds is never empty: an empty list would read as "no limit" to a careless
	// reader, so it is refused here rather than carried.
	if (projectIds !== null && projectIds.length === 0) return null;
	return { scopes: reading.scopes, projectIds: projectIds === null ? null : [...projectIds] };
}
