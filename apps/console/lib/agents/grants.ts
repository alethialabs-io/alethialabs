// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A person's connected agents in one org (AGT-L2, gap G8's read and revoke halves): the live
// `agent_oauth_grants` rows, shown through the agent-app catalogue, and disconnecting one.
//
// ONLY THE PERSON'S OWN. Every read and write here names `user_id` AND `org_id`, and runs in the
// person's scoped transaction, where the grants' row security (programmables.sql, `owner_only`)
// requires both again. Seeing or disconnecting a teammate's connections is a later decision (O2).
//
// DISCONNECTING keeps the grant row (with `revoked_at`) for the audit trail, deletes the client's
// access and refresh tokens for this person, and empties the scopes of their Better Auth consent, so
// the next authorization from that app returns to the consent screen instead of being answered from
// the old consent.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type AgentAppIdentity, agentAppIdentity } from "@/lib/agents/catalog";
import type { AgentScope } from "@/lib/approvals/types";
import type { Tx } from "@/lib/db";
import { getServiceDb } from "@/lib/db";
import { agentOauthGrants, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@/lib/db/schema";

/** One connected agent, as the connected-agents board shows it. */
export interface ConnectedAgent {
	grantId: string;
	clientId: string;
	identity: AgentAppIdentity;
	/** Whether the client arrived through its own published metadata document (CIMD). */
	verified: boolean;
	scopes: AgentScope[];
	/** null means every project in the org. */
	projectIds: string[] | null;
	connectedAt: string;
}

/** The person's live grants in `orgId`, newest first, in `db` opened in their scope. */
export async function listConnectedAgents(db: Tx, orgId: string, userId: string): Promise<ConnectedAgent[]> {
	const rows = await db
		.select({
			id: agentOauthGrants.id,
			client_id: agentOauthGrants.client_id,
			scopes: agentOauthGrants.scopes,
			project_ids: agentOauthGrants.project_ids,
			created_at: agentOauthGrants.created_at,
		})
		.from(agentOauthGrants)
		.where(and(eq(agentOauthGrants.org_id, orgId), eq(agentOauthGrants.user_id, userId), isNull(agentOauthGrants.revoked_at)))
		.orderBy(desc(agentOauthGrants.created_at));
	if (rows.length === 0) return [];
	const clients = await getServiceDb()
		.select({ clientId: oauthClient.clientId, name: oauthClient.name, icon: oauthClient.icon, discovery: oauthClient.clientDiscoveryId })
		.from(oauthClient)
		.where(inArray(oauthClient.clientId, [...new Set(rows.map((r) => r.client_id))]));
	const byId = new Map(clients.map((c) => [c.clientId, c]));
	return rows.map((r) => {
		const client = byId.get(r.client_id);
		return {
			grantId: r.id,
			clientId: r.client_id,
			identity: agentAppIdentity({ clientId: r.client_id, name: client?.name ?? null, icon: client?.icon ?? null }),
			verified: !!client?.discovery,
			scopes: r.scopes,
			projectIds: r.project_ids,
			connectedAt: r.created_at.toISOString(),
		};
	});
}

/**
 * Disconnects the person's grant `grantId` in `orgId` (see the header). Returns the client id it was
 * for, or null when there is no such live grant of theirs — another person's grant, another org's,
 * and an already-disconnected one all read the same.
 */
export async function revokeAgentGrant(db: Tx, orgId: string, userId: string, grantId: string): Promise<string | null> {
	const [revoked] = await db
		.update(agentOauthGrants)
		.set({ revoked_at: sql`now()`, updated_at: sql`now()` })
		.where(
			and(
				eq(agentOauthGrants.id, grantId),
				eq(agentOauthGrants.org_id, orgId),
				eq(agentOauthGrants.user_id, userId),
				isNull(agentOauthGrants.revoked_at),
			),
		)
		.returning({ client_id: agentOauthGrants.client_id, consent_id: agentOauthGrants.consent_id });
	if (!revoked) return null;
	const service = getServiceDb();
	await service.transaction(async (tx) => {
		// Access tokens first: they reference refresh tokens.
		await tx
			.delete(oauthAccessToken)
			.where(and(eq(oauthAccessToken.clientId, revoked.client_id), eq(oauthAccessToken.userId, userId)));
		await tx
			.delete(oauthRefreshToken)
			.where(and(eq(oauthRefreshToken.clientId, revoked.client_id), eq(oauthRefreshToken.userId, userId)));
		await tx
			.update(oauthConsent)
			.set({ scopes: [], updatedAt: sql`now()` })
			.where(and(eq(oauthConsent.id, revoked.consent_id), eq(oauthConsent.userId, userId)));
	});
	return revoked.client_id;
}
