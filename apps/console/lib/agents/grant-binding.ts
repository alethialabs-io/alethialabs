// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What binds an MCP request to a person's consent (AGT-L2-F, spec §5a/§5b): the `agent_oauth_grants`
// row for the access token's (subject, client), read on every request.
//
// THREE ANSWERS, NOT TWO. MCP access tokens are JWTs verified against the JWKS, so deleting the
// stored token rows on disconnect does not stop a token already handed out; only this read does.
// A grant that exists but is revoked therefore has to read differently from no grant at all:
//
//   · live    — the newest live grant: its org, scopes and projects bind the request;
//   · revoked — the person has grants for this client and every one is revoked: the request is
//               refused, whatever lifetime the token has left;
//   · none    — no grant row was ever written (a token issued before consent grants existed): the
//               token's own scopes, as before grants.
//
// Read before any actor exists, so through the service connection. The predicate is the verified
// token's own subject and client — nothing a caller chooses.

import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AgentScope } from "@/lib/approvals/types";
import { getServiceDb } from "@/lib/db";
import { agentOauthGrants } from "@/lib/db/schema";

/** What a person's MCP consent narrowed the agent to (`agent_oauth_grants`). */
export interface AgentGrant {
	orgId: string;
	scopes: readonly AgentScope[];
	/** Null: every project in the org. Never empty (the table's check constraint). */
	projectIds: readonly string[] | null;
}

/** The grant a token is bound to (see the header). */
export type GrantBinding = { kind: "live"; grant: AgentGrant } | { kind: "revoked" } | { kind: "none" };

/**
 * Reads the grant person `userId` gave OAuth client `clientId`: the newest live one, else whether
 * a revoked one exists. Live rows sort first (`revoked_at` NULLS FIRST), then the newest.
 */
export async function readGrantBinding(userId: string, clientId: string): Promise<GrantBinding> {
	const [row] = await getServiceDb()
		.select({
			org_id: agentOauthGrants.org_id,
			scopes: agentOauthGrants.scopes,
			project_ids: agentOauthGrants.project_ids,
			revoked_at: agentOauthGrants.revoked_at,
		})
		.from(agentOauthGrants)
		.where(and(eq(agentOauthGrants.user_id, userId), eq(agentOauthGrants.client_id, clientId)))
		.orderBy(sql`${agentOauthGrants.revoked_at} desc nulls first`, desc(agentOauthGrants.updated_at))
		.limit(1);
	if (!row) return { kind: "none" };
	if (row.revoked_at !== null) return { kind: "revoked" };
	return { kind: "live", grant: { orgId: row.org_id, scopes: row.scopes, projectIds: row.project_ids } };
}
