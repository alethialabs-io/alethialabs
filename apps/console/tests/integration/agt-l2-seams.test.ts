// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the AGT-L2 server seams against real Postgres and its row security.
//
//   · the approvals list (`queryApprovalsPage`): effective status, keyset paging with no overlap,
//     facets over the UNFILTERED universe, the project scope, and the org scope under RLS;
//   · the decision reason column, and its 500-character limit in the database;
//   · the agent policy upsert (`writeAgentPolicy`), first write inserting the row;
//   · the consent grant (`writeGrantForConsent`) bound to Better Auth's consent row, a re-consent
//     replacing it, and disconnecting (`revokeAgentGrant`) keeping the row, withdrawing the tokens
//     and emptying the consent;
//   · the "already answered" marker for a consent request;
//   · the auto-approve write (`writeAutoApprove`) bound to the token's org.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { consentAlreadyAnswered, markConsentAnswered, writeGrantForConsent } from "@/lib/agents/consent";
import { revokeAgentGrant } from "@/lib/agents/grants";
import { readAgentPolicySettings, writeAgentPolicy } from "@/lib/agents/policy";
import { autoApproveFacts, writeAutoApprove } from "@/lib/agents/service-tokens";
import { getServiceDb, withScope } from "@/lib/db";
import {
	agentOauthGrants,
	applyApprovals,
	cliServiceTokens,
	jobs,
	oauthAccessToken,
	oauthClient,
	oauthConsent,
	orgAgentPolicy,
	projectEnvironments,
	projects,
	user,
	verification,
} from "@/lib/db/schema";
import { queryApprovalsPage } from "@/lib/queries/approvals";
import { decodeKeysetCursor } from "@/lib/queries/keyset";
import { APP_ROLE_DISTINCT, describeIfDb } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const PERSON = randomUUID();
const DIGEST = "5e".repeat(32);
const CLIENT_ID = `https://agent-${randomUUID().slice(0, 8)}.example.test/client.json`;
const MINUTE = 60_000;

let projectId: string;
let stagingId: string;
let productionId: string;
let otherProjectId: string;
/** Approval ids, newest first. */
const approvalIds: string[] = [];
let consentId: string;
let tokenId: string;

/** Inserts a succeeded PLAN job on `environmentId` and returns its id. */
async function planJob(environmentId: string, project: string, org = ORG): Promise<string> {
	const [job] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: PERSON,
			org_id: org,
			project_id: project,
			environment_id: environmentId,
			job_type: "PLAN",
			status: "SUCCESS",
			plan_sha256: DIGEST,
			created_at: new Date(Date.now() - 300 * MINUTE),
		})
		.returning({ id: jobs.id });
	return job.id;
}

/** The first page (or the page after `cursor`) for PERSON in ORG viewing `projectIds`. */
function page(projectIds: string[], filter = {}, cursor?: string | null, limit = 50) {
	const position = cursor ? (decodeKeysetCursor(cursor) ?? undefined) : undefined;
	return withScope({ ownerId: PERSON, orgId: ORG }, (tx) => queryApprovalsPage(tx, ORG, projectIds, filter, { cursor: position, limit }));
}

describeIfDb("AGT-L2 seams", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values({ id: PERSON, name: "Dana Requester", email: `dana-${PERSON}@example.test` });
		const [p] = await db
			.insert(projects)
			.values({ user_id: PERSON, org_id: ORG, project_name: `payments-${PERSON.slice(0, 6)}`, region: "eu-west-1", iac_version: "1.9.5" })
			.returning({ id: projects.id });
		projectId = p.id;
		const envs = await db
			.insert(projectEnvironments)
			.values([
				{ project_id: projectId, user_id: PERSON, name: "staging", stage: "staging", status: "ACTIVE", is_default: true },
				{ project_id: projectId, user_id: PERSON, name: "production", stage: "production", status: "ACTIVE" },
			])
			.returning({ id: projectEnvironments.id, name: projectEnvironments.name });
		stagingId = envs.find((e) => e.name === "staging")?.id ?? "";
		productionId = envs.find((e) => e.name === "production")?.id ?? "";
		const [other] = await db
			.insert(projects)
			.values({ user_id: PERSON, org_id: ORG, project_name: `hidden-${PERSON.slice(0, 6)}`, region: "eu-west-1", iac_version: "1.9.5" })
			.returning({ id: projects.id });
		otherProjectId = other.id;
		const [otherEnv] = await db
			.insert(projectEnvironments)
			.values({ project_id: otherProjectId, user_id: PERSON, name: "staging", stage: "staging", status: "ACTIVE", is_default: true })
			.returning({ id: projectEnvironments.id });

		const stagingPlan = await planJob(stagingId, projectId);
		const productionPlan = await planJob(productionId, projectId);
		const hiddenPlan = await planJob(otherEnv.id, otherProjectId);

		const now = Date.now();
		const base = {
			org_id: ORG,
			project_id: projectId,
			plan_sha256: DIGEST,
			requester_user_id: PERSON,
		};
		// Newest first: a live pending deploy, an expired pending deploy, a denied production destroy,
		// and an older approved-then-expired deploy. Plus one on the project the viewer cannot see.
		const rows = await db
			.insert(applyApprovals)
			.values([
				{ ...base, environment_id: stagingId, plan_job_id: stagingPlan, operation: "deploy", requester_credential: "agent_oauth", requester_credential_ref: CLIENT_ID, created_at: new Date(now - 1 * MINUTE), expires_at: new Date(now + 60 * MINUTE) },
				{ ...base, environment_id: stagingId, plan_job_id: stagingPlan, operation: "deploy", requester_credential: "cli_session", created_at: new Date(now - 120 * MINUTE), expires_at: new Date(now - 60 * MINUTE) },
				{ ...base, environment_id: productionId, plan_job_id: productionPlan, operation: "destroy", requester_credential: "agent_oauth", status: "rejected", approver_user_id: PERSON, decided_at: new Date(now - 150 * MINUTE), decision_reason: "not this week", created_at: new Date(now - 160 * MINUTE), expires_at: new Date(now - 100 * MINUTE) },
				{ ...base, environment_id: stagingId, plan_job_id: stagingPlan, operation: "deploy", requester_credential: "service_token", status: "approved", approver_user_id: PERSON, decided_at: new Date(now - 190 * MINUTE), created_at: new Date(now - 200 * MINUTE), expires_at: new Date(now - 170 * MINUTE) },
				{ ...base, project_id: otherProjectId, environment_id: otherEnv.id, plan_job_id: hiddenPlan, operation: "deploy", requester_credential: "cli_session", created_at: new Date(now - 2 * MINUTE), expires_at: new Date(now + 60 * MINUTE) },
			])
			.returning({ id: applyApprovals.id, project_id: applyApprovals.project_id, created_at: applyApprovals.created_at });
		approvalIds.push(
			...rows
				.filter((r) => r.project_id === projectId)
				.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
				.map((r) => r.id),
		);

		await db.insert(oauthClient).values({ clientId: CLIENT_ID, name: "Release helper", redirectUris: ["https://example.test/cb"], clientDiscoveryId: CLIENT_ID });
		const [consent] = await db
			.insert(oauthConsent)
			.values({ clientId: CLIENT_ID, userId: PERSON, scopes: ["openid", "read", "plan"] })
			.returning({ id: oauthConsent.id });
		consentId = consent.id;
		await db.insert(oauthAccessToken).values({
			token: `tok-${randomUUID()}`,
			clientId: CLIENT_ID,
			userId: PERSON,
			expiresAt: new Date(now + 60 * MINUTE),
			scopes: ["read"],
		});
		const [token] = await db
			.insert(cliServiceTokens)
			.values({ organization_id: ORG, name: "ci", token_hash: `hash-${randomUUID()}`, token_prefix: "alethia_sat_test" })
			.returning({ id: cliServiceTokens.id });
		tokenId = token.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(applyApprovals).where(inArray(applyApprovals.org_id, [ORG, OTHER_ORG]));
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await db.delete(agentOauthGrants).where(eq(agentOauthGrants.client_id, CLIENT_ID));
		await db.delete(oauthAccessToken).where(eq(oauthAccessToken.clientId, CLIENT_ID));
		await db.delete(oauthConsent).where(eq(oauthConsent.clientId, CLIENT_ID));
		await db.delete(oauthClient).where(eq(oauthClient.clientId, CLIENT_ID));
		await db.delete(cliServiceTokens).where(eq(cliServiceTokens.organization_id, ORG));
		await db.delete(orgAgentPolicy).where(eq(orgAgentPolicy.org_id, ORG));
		await db.delete(user).where(eq(user.id, PERSON));
	});

	it("lists the viewable project's approvals newest first, with the effective status", async () => {
		const result = await page([projectId]);
		expect(result.rows.map((r) => r.id)).toEqual(approvalIds);
		expect(result.rows.map((r) => r.status)).toEqual(["pending", "expired", "rejected", "expired"]);
		expect(result.rows[0]).toMatchObject({
			environment_name: "staging",
			environment_stage: "staging",
			requester_name: "Dana Requester",
			requester_credential: "agent_oauth",
			requester_credential_name: "Release helper",
			digest_prefix: DIGEST.slice(0, 8),
		});
		expect(result.rows[2]).toMatchObject({ operation: "destroy", environment_stage: "production", approver_name: "Dana Requester" });
		expect(result.nextCursor).toBeNull();
		expect(result.universeEmpty).toBe(false);
	});

	it("pages by keyset without skipping or repeating a row", async () => {
		const first = await page([projectId], {}, undefined, 2);
		expect(first.rows.map((r) => r.id)).toEqual(approvalIds.slice(0, 2));
		expect(first.nextCursor).not.toBeNull();
		const second = await page([projectId], {}, first.nextCursor, 2);
		expect(second.rows.map((r) => r.id)).toEqual(approvalIds.slice(2, 4));
		expect(second.facets).toBeNull();
		expect(second.nextCursor).toBeNull();
	});

	it("filters by status in the query and counts facets over the unfiltered universe", async () => {
		const result = await page([projectId], { status: ["expired"] });
		expect(result.rows.map((r) => r.id)).toEqual([approvalIds[1], approvalIds[3]]);
		const counts = Object.fromEntries((result.facets?.status ?? []).map((o) => [o.value, o.count]));
		expect(counts).toMatchObject({ pending: 1, expired: 2, rejected: 1, approved: 0 });
		const credentials = Object.fromEntries((result.facets?.credential ?? []).map((o) => [o.value, o.count]));
		expect(credentials).toEqual({ cli_session: 1, agent_oauth: 2, service_token: 1 });
	});

	it("filters by operation, environment and search", async () => {
		expect((await page([projectId], { operation: ["destroy"] })).rows.map((r) => r.id)).toEqual([approvalIds[2]]);
		expect((await page([projectId], { environment: [productionId] })).rows.map((r) => r.id)).toEqual([approvalIds[2]]);
		expect((await page([projectId], { search: "product" })).rows.map((r) => r.id)).toEqual([approvalIds[2]]);
		expect((await page([projectId], { status: ["not-a-status"] })).rows).toHaveLength(4);
	});

	it("lists nothing on a project the viewer may not view", async () => {
		const result = await page([]);
		expect(result.rows).toEqual([]);
		expect((await page([projectId])).rows.every((r) => r.project_id === projectId)).toBe(true);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("reads nothing of another org under row security", async () => {
		const result = await withScope({ ownerId: PERSON, orgId: OTHER_ORG }, (tx) =>
			queryApprovalsPage(tx, ORG, [projectId], {}, { limit: 50 }),
		);
		expect(result.rows).toEqual([]);
	});

	it("refuses a decision reason over 500 characters in the database", async () => {
		await expect(
			getServiceDb().update(applyApprovals).set({ decision_reason: "x".repeat(501) }).where(eq(applyApprovals.id, approvalIds[2])),
		).rejects.toThrow();
	});

	it("inserts the policy row on the first change and updates it after", async () => {
		const before = await withScope({ ownerId: PERSON, orgId: ORG }, (tx) => readAgentPolicySettings(tx, ORG));
		expect(before.updatedBy).toBeNull();
		const after = await withScope({ ownerId: PERSON, orgId: ORG }, (tx) =>
			writeAgentPolicy(tx, ORG, PERSON, { agentAccessEnabled: false }),
		);
		expect(after).toMatchObject({ agentAccessEnabled: false, agentsMayNotApplyToProduction: false, approvalTtlMinutes: 60 });
		expect(after.updatedBy).toEqual({ id: PERSON, name: "Dana Requester" });
		const again = await withScope({ ownerId: PERSON, orgId: ORG }, (tx) =>
			writeAgentPolicy(tx, ORG, PERSON, { approvalTtlMinutes: 240 }),
		);
		expect(again).toMatchObject({ agentAccessEnabled: false, approvalTtlMinutes: 240 });
	});

	it("writes one grant per consent, replaces it on re-consent, and keeps it on disconnect", async () => {
		const grantId = await withScope({ ownerId: PERSON, orgId: ORG }, (tx) =>
			writeGrantForConsent(tx, { orgId: ORG, userId: PERSON, clientId: CLIENT_ID, scopes: ["read", "plan"], projectIds: [projectId] }),
		);
		expect(grantId).not.toBeNull();
		const replaced = await withScope({ ownerId: PERSON, orgId: ORG }, (tx) =>
			writeGrantForConsent(tx, { orgId: ORG, userId: PERSON, clientId: CLIENT_ID, scopes: ["read"], projectIds: null }),
		);
		expect(replaced).toBe(grantId);
		const [row] = await getServiceDb().select().from(agentOauthGrants).where(eq(agentOauthGrants.consent_id, consentId));
		expect(row).toMatchObject({ scopes: ["read"], project_ids: null, org_id: ORG, revoked_at: null });

		const clientId = await withScope({ ownerId: PERSON, orgId: ORG }, (tx) => revokeAgentGrant(tx, ORG, PERSON, grantId ?? ""));
		expect(clientId).toBe(CLIENT_ID);
		const [kept] = await getServiceDb().select().from(agentOauthGrants).where(eq(agentOauthGrants.id, grantId ?? ""));
		expect(kept?.revoked_at).not.toBeNull();
		const tokens = await getServiceDb().select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, CLIENT_ID));
		expect(tokens).toEqual([]);
		const [consent] = await getServiceDb().select({ scopes: oauthConsent.scopes }).from(oauthConsent).where(eq(oauthConsent.id, consentId));
		expect(consent?.scopes).toEqual([]);
		// A second disconnect finds nothing live.
		expect(await withScope({ ownerId: PERSON, orgId: ORG }, (tx) => revokeAgentGrant(tx, ORG, PERSON, grantId ?? ""))).toBeNull();
	});

	it("records a consent request as answered until it expires", async () => {
		const key = `k-${randomUUID()}`;
		expect(await consentAlreadyAnswered(key)).toBe(false);
		await markConsentAnswered(key, "allowed", new Date(Date.now() + 5 * MINUTE));
		expect(await consentAlreadyAnswered(key)).toBe(true);
		const lapsed = `k-${randomUUID()}`;
		await markConsentAnswered(lapsed, "denied", new Date(Date.now() - MINUTE));
		expect(await consentAlreadyAnswered(lapsed)).toBe(false);
		await getServiceDb().delete(verification).where(inArray(verification.identifier, [`agent-consent-answered:${key}`, `agent-consent-answered:${lapsed}`]));
	});

	it("writes a token's auto-approve list only in its own org", async () => {
		const facts = await autoApproveFacts(ORG, [stagingId, productionId]);
		expect(facts.map((f) => f.stage).sort()).toEqual(["production", "staging"]);
		expect(await autoApproveFacts(OTHER_ORG, [stagingId])).toEqual([]);
		expect(await writeAutoApprove(OTHER_ORG, tokenId, [stagingId])).toBe(false);
		expect(await writeAutoApprove(ORG, tokenId, [stagingId, stagingId])).toBe(true);
		const [row] = await getServiceDb()
			.select({ ids: cliServiceTokens.auto_approve_environment_ids })
			.from(cliServiceTokens)
			.where(and(eq(cliServiceTokens.id, tokenId), eq(cliServiceTokens.organization_id, ORG)));
		expect(row?.ids).toEqual([stagingId]);
	});
});
