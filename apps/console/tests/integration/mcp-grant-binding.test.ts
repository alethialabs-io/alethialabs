// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the MCP request's binding to its consent grant (AGT-L2-F) against real Postgres.
//
//   · `readGrantBinding` answers live / revoked / ungranted / none for (subject, client), never
//     another person's or another client's grant, and a live grant over a revoked one;
//   · `resolveMcpActor` with that real read acts in the grant's org and projects, a disconnect
//     through the real `revokeAgentGrant` refuses the next resolution of the same claims, and a
//     consent with no grant is refused and released (its scopes emptied) without touching a consent
//     that has one;
//   · `restoreConsent` puts a person's consent rows back as a snapshot recorded them: a row created
//     since is deleted, a row updated since gets its earlier scopes.
//
// Membership and the agent switch are stood in: the person's org resolution is the edition's, and
// it is exercised by the unit tests; the grant read is what this file proves against the database.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readConsentSnapshot, restoreConsent } from "@/lib/agents/consent";
import { readGrantBinding, releaseUngrantedConsent } from "@/lib/agents/grant-binding";
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
const CONSENT_ONLY_CLIENT = `https://agent-${randomUUID().slice(0, 8)}.example.test/client.json`;
const RESTORE_CLIENT = `https://agent-${randomUUID().slice(0, 8)}.example.test/client.json`;
const ALL_CLIENTS = [CLIENT, OTHER_CLIENT, NEVER_GRANTED_CLIENT, CONSENT_ONLY_CLIENT, RESTORE_CLIENT];

/** The scopes of every consent row (`userId`, `clientId`) has, by row id. */
async function consentScopes(userId: string, clientId: string): Promise<Map<string, string[]>> {
	const rows = await getServiceDb()
		.select({ id: oauthConsent.id, scopes: oauthConsent.scopes })
		.from(oauthConsent)
		.where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
	return new Map(rows.map((r) => [r.id, r.scopes]));
}

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
		releaseUngrantedConsent,
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
			ALL_CLIENTS.map((clientId) => ({
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
		// A consent recorded for CONSENT_ONLY_CLIENT with no grant written beside it.
		await db.insert(oauthConsent).values({ clientId: CONSENT_ONLY_CLIENT, userId: PERSON, scopes: ["openid", "read"] });
	});

	afterAll(async () => {
		const db = getServiceDb();
		const clients = ALL_CLIENTS;
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

	it("answers ungranted for a client with a consent record but no grant row", async () => {
		expect(await readGrantBinding(PERSON, CONSENT_ONLY_CLIENT)).toEqual({ kind: "ungranted" });
	});

	it("refuses a consent with no grant and releases it, leaving a consent with a grant as it was", async () => {
		const withGrant = await consentScopes(PERSON, CLIENT);
		const result = await resolveMcpActor({ sub: PERSON, scope: "openid read", azp: CONSENT_ONLY_CLIENT }, null, deps());
		expect(result).toEqual({ ok: false, reason: "grant_missing" });
		expect([...(await consentScopes(PERSON, CONSENT_ONLY_CLIENT)).values()]).toEqual([[]]);
		// Releasing names a client; and even for that client a consent with a grant row is never touched.
		await releaseUngrantedConsent(PERSON, CLIENT);
		expect(await consentScopes(PERSON, CLIENT)).toEqual(withGrant);
	});

	it("restores a consent snapshot: a row created since is deleted", async () => {
		const before = await readConsentSnapshot(RESTORE_CLIENT, PERSON);
		expect(before.rows).toEqual([]);
		await getServiceDb().insert(oauthConsent).values({ clientId: RESTORE_CLIENT, userId: PERSON, scopes: ["openid", "read"] });
		await restoreConsent(before);
		expect((await consentScopes(PERSON, RESTORE_CLIENT)).size).toBe(0);
	});

	it("restores a consent snapshot without deleting a row created since that has a grant", async () => {
		const before = await readConsentSnapshot(RESTORE_CLIENT, OTHER_PERSON);
		const granted = await grant(OTHER_PERSON, RESTORE_CLIENT, ORG, null);
		await restoreConsent(before);
		expect((await consentScopes(OTHER_PERSON, RESTORE_CLIENT)).size).toBe(1);
		await getServiceDb().delete(agentOauthGrants).where(eq(agentOauthGrants.id, granted));
		await getServiceDb()
			.delete(oauthConsent)
			.where(and(eq(oauthConsent.userId, OTHER_PERSON), eq(oauthConsent.clientId, RESTORE_CLIENT)));
	});

	it("restores a consent snapshot: a row updated since gets its earlier scopes back", async () => {
		const db = getServiceDb();
		const [row] = await db
			.insert(oauthConsent)
			.values({ clientId: RESTORE_CLIENT, userId: PERSON, scopes: ["openid", "read"] })
			.returning({ id: oauthConsent.id });
		const before = await readConsentSnapshot(RESTORE_CLIENT, PERSON);
		await db.update(oauthConsent).set({ scopes: ["openid", "read", "apply"] }).where(eq(oauthConsent.id, row.id));
		// Another person's consent to the same client is outside the snapshot and stays.
		await db.insert(oauthConsent).values({ clientId: RESTORE_CLIENT, userId: OTHER_PERSON, scopes: ["openid"] });
		await restoreConsent(before);
		expect(await consentScopes(PERSON, RESTORE_CLIENT)).toEqual(new Map([[row.id, ["openid", "read"]]]));
		expect((await consentScopes(OTHER_PERSON, RESTORE_CLIENT)).size).toBe(1);
	});
});
