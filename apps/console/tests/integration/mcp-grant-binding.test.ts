// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the MCP request's binding to its consent grant (AGT-L2-F) against real Postgres.
//
//   · `readGrantBinding` answers live / revoked / none for (subject, client), never another
//     person's or another client's grant, and a live grant over a revoked one;
//   · `resolveMcpActor` with that real read acts in the grant's org and projects, and a disconnect
//     through the real `revokeAgentGrant` refuses the next resolution of the same claims.
//
// Membership and the agent switch are stood in: the person's org resolution is the edition's, and
// it is exercised by the unit tests; the grant read is what this file proves against the database.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readGrantBinding } from "@/lib/agents/grant-binding";
import { revokeAgentGrant } from "@/lib/agents/grants";
import { type McpActorDeps, resolveMcpActor } from "@/lib/ai/mcp/actor";
import { getServiceDb, withScope } from "@/lib/db";
import { agentOauthGrants, oauthClient, oauthConsent, user } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const PERSON = randomUUID();
const OTHER_PERSON = randomUUID();
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const PROJECT = randomUUID();
const CLIENT = `https://agent-${randomUUID().slice(0, 8)}.example.test/client.json`;
const OTHER_CLIENT = `https://agent-${randomUUID().slice(0, 8)}.example.test/client.json`;
const NEVER_GRANTED_CLIENT = `https://agent-${randomUUID().slice(0, 8)}.example.test/client.json`;

let liveGrantId: string;

/** Inserts a consent for (`userId`, `clientId`) and its grant; returns the grant id. */
async function grant(userId: string, clientId: string, orgId: string, projectIds: string[] | null, revoked = false): Promise<string> {
	const db = getServiceDb();
	const [consent] = await db
		.insert(oauthConsent)
		.values({ clientId, userId, scopes: ["openid", "read", "plan"] })
		.returning({ id: oauthConsent.id });
	const [row] = await db
		.insert(agentOauthGrants)
		.values({
			consent_id: consent.id,
			org_id: orgId,
			user_id: userId,
			client_id: clientId,
			scopes: ["read", "plan"],
			project_ids: projectIds,
			revoked_at: revoked ? new Date() : null,
		})
		.returning({ id: agentOauthGrants.id });
	return row.id;
}

/** Resolution deps over the REAL grant read; the person is an active member of ORG only. */
function deps(): McpActorDeps {
	return {
		readGrant: readGrantBinding,
		resolveScope: vi.fn(async (userId: string, orgId?: string) => ({ userId, orgId: orgId === ORG ? ORG : userId })),
		agentAccessEnabled: vi.fn(async () => true),
	};
}

const CLAIMS = { sub: PERSON, scope: "openid read plan", azp: CLIENT };

describeIfDb("MCP grant binding", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values([
			{ id: PERSON, name: "Mira Agent", email: `mira-${PERSON}@example.test` },
			{ id: OTHER_PERSON, name: "Ola Other", email: `ola-${OTHER_PERSON}@example.test` },
		]);
		await db.insert(oauthClient).values(
			[CLIENT, OTHER_CLIENT, NEVER_GRANTED_CLIENT].map((clientId) => ({
				clientId,
				name: "Agent",
				redirectUris: ["https://example.test/cb"],
			})),
		);
		// An older revoked grant in another org beside the live one: the live one must win.
		await grant(PERSON, CLIENT, OTHER_ORG, null, true);
		liveGrantId = await grant(PERSON, CLIENT, ORG, [PROJECT]);
		// Every grant OTHER_CLIENT has from PERSON is revoked; OTHER_PERSON's grant to it is live.
		await grant(PERSON, OTHER_CLIENT, ORG, null, true);
		await grant(OTHER_PERSON, OTHER_CLIENT, OTHER_ORG, null);
	});

	afterAll(async () => {
		const db = getServiceDb();
		const clients = [CLIENT, OTHER_CLIENT, NEVER_GRANTED_CLIENT];
		await db.delete(agentOauthGrants).where(inArray(agentOauthGrants.client_id, clients));
		await db.delete(oauthConsent).where(inArray(oauthConsent.clientId, clients));
		await db.delete(oauthClient).where(inArray(oauthClient.clientId, clients));
		await db.delete(user).where(inArray(user.id, [PERSON, OTHER_PERSON]));
	});

	it("reads the live grant over an older revoked one", async () => {
		expect(await readGrantBinding(PERSON, CLIENT)).toEqual({
			kind: "live",
			grant: { orgId: ORG, scopes: ["read", "plan"], projectIds: [PROJECT] },
		});
	});

	it("answers revoked for the person's own revoked grants, never borrowing another person's live one", async () => {
		expect(await readGrantBinding(PERSON, OTHER_CLIENT)).toEqual({ kind: "revoked" });
	});

	it("answers none for a client the person never granted", async () => {
		expect(await readGrantBinding(PERSON, NEVER_GRANTED_CLIENT)).toEqual({ kind: "none" });
	});

	it("binds the actor to the grant's org and projects", async () => {
		expect(await resolveMcpActor(CLAIMS, null, deps())).toMatchObject({
			ok: true,
			actor: { userId: PERSON, orgId: ORG, credentialRef: CLIENT, ceiling: { scopes: ["read", "plan"], projectIds: [PROJECT] } },
		});
	});

	it("refuses a project outside the grant", async () => {
		expect(await resolveMcpActor(CLAIMS, randomUUID(), deps())).toEqual({ ok: false, reason: "project_not_permitted" });
	});

	it("refuses a live grant in an org the person is not a member of", async () => {
		const result = await resolveMcpActor({ sub: OTHER_PERSON, scope: "read", azp: OTHER_CLIENT }, null, deps());
		expect(result).toEqual({ ok: false, reason: "org_not_permitted" });
	});

	it("refuses the next resolution of the same claims once the grant is disconnected", async () => {
		const clientId = await withScope({ ownerId: PERSON, orgId: ORG }, (tx) => revokeAgentGrant(tx, ORG, PERSON, liveGrantId));
		expect(clientId).toBe(CLIENT);
		const [row] = await getServiceDb().select().from(agentOauthGrants).where(eq(agentOauthGrants.id, liveGrantId));
		expect(row?.revoked_at).not.toBeNull();
		expect(await resolveMcpActor(CLAIMS, null, deps())).toEqual({ ok: false, reason: "grant_revoked" });
	});
});
