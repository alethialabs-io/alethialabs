// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What binds an MCP request to a person's consent (AGT-L2-F, spec §5a/§5b): the `agent_oauth_grants`
// row for the access token's (subject, client), read on every request.
//
// FIVE ANSWERS, NOT TWO. MCP access tokens are JWTs verified against the JWKS, so deleting the
// stored token rows on disconnect does not stop a token already handed out; only this read does.
// A grant that exists but is revoked therefore has to read differently from no grant at all, and a
// consent with no grant differently from neither:
//
//   · live      — the newest live grant: its org, scopes and projects bind the request;
//   · revoked   — the person has grants for this client and every one is revoked: the request is
//                 refused, whatever lifetime the token has left;
//   · ungranted — no grant row, but the person has a consent record for this client. A consent and
//                 its grant are recorded together (app/server/actions/agents/consent.ts), so this
//                 consent has no organization, scopes or projects recorded for it: the request is
//                 refused, never answered with the token's own scopes;
//   · unconsented — no grant row and no consent record, for a client that is NOT marked to skip the
//                 consent screen. Better Auth issues such a client a code only after a consent, so a
//                 token for it with neither row was issued under a consent that is gone (removed, or
//                 replaced outside the console's connect flow): the request is refused;
//   · none      — no grant row and no consent record for a client marked `skip_consent` (a
//                 first-party client Better Auth issues codes to without the consent screen): the
//                 token's own scopes, as before grants. No client is marked so by the console itself.
//
// Read before any actor exists, so through the service connection. The predicate is the verified
// token's own subject and client — nothing a caller chooses.

import "server-only";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import type { AgentScope } from "@/lib/approvals/types";
import { getServiceDb } from "@/lib/db";
import { agentOauthGrants, oauthClient, oauthConsent } from "@/lib/db/schema";

/** What a person's MCP consent narrowed the agent to (`agent_oauth_grants`). */
export interface AgentGrant {
	orgId: string;
	scopes: readonly AgentScope[];
	/** Null: every project in the org. Never empty (the table's check constraint). */
	projectIds: readonly string[] | null;
}

/** The grant a token is bound to (see the header). */
export type GrantBinding =
	| { kind: "live"; grant: AgentGrant }
	| { kind: "revoked" }
	| { kind: "ungranted" }
	| { kind: "unconsented" }
	| { kind: "none" };

/**
 * Reads the grant person `userId` gave OAuth client `clientId`: the newest live one, else whether
 * a revoked one exists, else whether a consent record exists without any grant, else whether the
 * client is marked to skip consent. Live rows sort first (`revoked_at` NULLS FIRST), then the newest.
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
	if (!row) {
		if (await hasConsentRecord(userId, clientId)) return { kind: "ungranted" };
		return (await clientSkipsConsent(clientId)) ? { kind: "none" } : { kind: "unconsented" };
	}
	if (row.revoked_at !== null) return { kind: "revoked" };
	return { kind: "live", grant: { orgId: row.org_id, scopes: row.scopes, projectIds: row.project_ids } };
}

/** True when person `userId` has any consent record for OAuth client `clientId`. */
async function hasConsentRecord(userId: string, clientId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: oauthConsent.id })
		.from(oauthConsent)
		.where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
		.limit(1);
	return !!row;
}

/** True only when OAuth client `clientId` exists and is marked `skip_consent`; null or absent is false. */
async function clientSkipsConsent(clientId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ skipConsent: oauthClient.skipConsent })
		.from(oauthClient)
		.where(eq(oauthClient.clientId, clientId))
		.limit(1);
	return row?.skipConsent === true;
}

/**
 * Empties the scopes of person `userId`'s consent records for `clientId` that have no grant row, so
 * the next authorization from that client returns to the consent screen (where the grant is written)
 * instead of being answered from a consent that granted nothing — what a disconnect does to a consent
 * (lib/agents/grants.ts). A consent with a grant row, live or revoked, is never touched.
 */
export async function releaseUngrantedConsent(userId: string, clientId: string): Promise<void> {
	await getServiceDb()
		.update(oauthConsent)
		.set({ scopes: [], updatedAt: sql`now()` })
		.where(
			and(
				eq(oauthConsent.userId, userId),
				eq(oauthConsent.clientId, clientId),
				notExists(
					getServiceDb()
						.select({ id: agentOauthGrants.id })
						.from(agentOauthGrants)
						.where(eq(agentOauthGrants.consent_id, oauthConsent.id)),
				),
			),
		);
}
