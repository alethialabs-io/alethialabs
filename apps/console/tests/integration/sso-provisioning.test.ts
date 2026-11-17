// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6892): access for a member who arrives through single sign-on, in the ENTERPRISE
// edition, against real Postgres.
//
// The SSO plugin adds a person to their organization by inserting a `member` row with the role
// `member` and nothing else. This file inserts that row the same way, then runs the enterprise
// module's own after-sign-in step — taken from the plugins `register(core)` returned, and called
// with the request context better-auth's dispatcher hands an after-hook — and reads what it left:
//
//  * exactly one organization-wide viewer grant, which the real PostgresRbacPDP authorizes from;
//  * exactly one seat reconciliation and one activity row;
//  * nothing more on a second sign-in — the same grant row, not a rewritten one;
//  * a member row that predates the step and never had a grant is granted on its next sign-in.
//
// And what it must NOT do, each with its own member: grant a role other than the one single
// sign-on provisions, grant in an organization the user did not reach through that organization's
// own verified provider, grant a suspended member, or grant in an organization that has recorded a
// grant revocation since the member joined.
//
// The seat reconciliation is the one stub: `lib/billing/seats` is replaced by a counter, because
// the real one is a Stripe call and the claim here is HOW MANY TIMES it is asked. The grant write,
// the activity write and the PDP are real.
//
// REQUIRES `ee/dist/index.js` (`pnpm -F @alethia/ee build`), as rpc-tenancy.enterprise.test.ts
// does: with `ALETHIA_EDITION=enterprise` a missing or broken module makes the load FAIL, and
// `beforeAll` asserts the edition, so this file goes red rather than skipping into a community
// answer. It skips only when the database is down.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/** Hoisted state: the edition to restore, and the organizations whose seats were reconciled. */
interface Hoisted {
	previousEdition: string | undefined;
	seatSyncs: string[];
}

const h = vi.hoisted((): Hoisted => {
	const previousEdition = process.env.ALETHIA_EDITION;
	// Before ANY import: the edition is decided on the first read of `lib/enterprise`.
	process.env.ALETHIA_EDITION = "enterprise";
	return { previousEdition, seatSyncs: [] };
});

vi.mock("@/lib/billing/seats", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/seats")>()),
	syncOrgSeats: async (orgId: string): Promise<void> => {
		h.seatSyncs.push(orgId);
	},
}));

import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import {
	account,
	authzActivityLog,
	grants,
	member,
	organization,
	ssoProvider,
	user,
} from "@/lib/db/schema";
import { editionState, getEnterprise } from "@/lib/enterprise";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

// At FILE level, so the edition is restored even when the suite below is skipped.
afterAll(() => {
	if (h.previousEdition === undefined) delete process.env.ALETHIA_EDITION;
	else process.env.ALETHIA_EDITION = h.previousEdition;
});

const RUN = randomUUID().slice(0, 8);

const ORG = randomUUID(); // owns a verified provider
const ORG_REVOKED = randomUUID(); // owns a verified provider; one grant revocation on record
const ORG_UNVERIFIED = randomUUID(); // owns a provider whose domain is not verified
const ALL_ORGS = [ORG, ORG_REVOKED, ORG_UNVERIFIED];

const PROVIDER = `it-sso-${RUN}`;
const PROVIDER_REVOKED = `it-sso-rev-${RUN}`;
const PROVIDER_UNVERIFIED = `it-sso-unv-${RUN}`;

const U = {
	admin: randomUUID(), // registered the providers; not under test
	fresh: randomUUID(), // added by this sign-in
	earlier: randomUUID(), // member row an hour old, never granted
	adminRole: randomUUID(), // ungranted, stored role 'admin'
	ownerRole: randomUUID(), // ungranted, stored role 'owner'
	suspended: randomUUID(), // suspended member
	unlinked: randomUUID(), // member of ORG with no account for ORG's provider
	revokedOrg: randomUUID(), // ungranted member of ORG_REVOKED
	unverified: randomUUID(), // ungranted member of ORG_UNVERIFIED
};
const ALL_USERS = Object.values(U);

const pdp = new PostgresRbacPDP();
const db = () => getServiceDb();

/** Can this user view projects in this org, per the real community PDP? */
async function canView(userId: string, orgId: string): Promise<boolean> {
	return (await pdp.can({ credential: "session", userId, orgId }, "view", { type: "project" }))
		.allowed;
}

/** The user's grant rows in one org. */
async function userGrants(orgId: string, userId: string) {
	return db()
		.select({
			id: grants.id,
			principal_type: grants.principal_type,
			role_id: grants.role_id,
			permission_key: grants.permission_key,
			resource_type: grants.resource_type,
			resource_id: grants.resource_id,
			effect: grants.effect,
		})
		.from(grants)
		.where(and(eq(grants.org_id, orgId), eq(grants.principal_id, userId)));
}

/** The activity rows this user is the actor of in one org. */
async function activityOf(orgId: string, userId: string) {
	return db()
		.select({
			action: authzActivityLog.action,
			resource_type: authzActivityLog.resource_type,
			resource_id: authzActivityLog.resource_id,
			decision: authzActivityLog.decision,
			reason: authzActivityLog.reason,
		})
		.from(authzActivityLog)
		.where(and(eq(authzActivityLog.org_id, orgId), eq(authzActivityLog.actor_id, userId)));
}

/** The enterprise module's plugins, in the order `register(core)` returned them. */
function enterprisePlugins() {
	return getEnterprise()?.authPlugins ?? [];
}

/** The after-sign-in step the enterprise module registered. */
function provisioningHook() {
	const plugin = enterprisePlugins().find((p) => p.id === "alethia-sso-provisioning");
	const hook = plugin?.hooks?.after?.[0];
	if (!hook) throw new Error("the enterprise module registered no SSO provisioning step");
	return hook;
}

/**
 * Completes a sign-in through an identity provider for `userId`, as far as the step under test
 * can see it: better-auth's dispatcher calls every after-hook whose matcher accepts the route
 * with the request context, on which the sign-in endpoint has left the session it created. Throws
 * when the step does not run for `path`, or logs an error.
 */
async function signIn(userId: string, path = "/sso/callback/:providerId"): Promise<void> {
	const hook = provisioningHook();
	const context = {
		path,
		context: { newSession: { user: { id: userId, email: `it-sso-${userId}@example.test` } } },
	};
	if (Reflect.apply(hook.matcher, undefined, [context]) !== true) {
		throw new Error(`the SSO provisioning step does not run for ${path}`);
	}
	// The step logs its own failure and lets the sign-in finish, so a broken query would read here
	// as "wrote no grant" — the very thing the refusal cases assert. A logged error fails the call.
	const error = vi.spyOn(console, "error");
	try {
		await Reflect.apply(hook.handler, undefined, [context]);
		if (error.mock.calls.length > 0) {
			throw new Error(`the SSO provisioning step logged an error: ${String(error.mock.calls[0]?.[0])}`);
		}
	} finally {
		error.mockRestore();
	}
}

/** Seat reconciliations asked for one org so far. */
function seatSyncs(orgId: string): number {
	return h.seatSyncs.filter((id) => id === orgId).length;
}

/** A property of an unknown value, when it is an object that has it. */
function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

describeIfDb("single sign-on provisioning (enterprise edition)", () => {
	beforeAll(async () => {
		// A precondition, not an assertion: every case below is about the enterprise module.
		const edition = editionState();
		if (edition.kind !== "enterprise") {
			throw new Error(`expected the enterprise edition, got ${edition.kind}`);
		}
		await seedAuthz(); // the built-in role rows grants.role_id references

		await db()
			.insert(user)
			.values(ALL_USERS.map((id) => ({ id, email: `it-sso-${id}@example.test` })));
		await db()
			.insert(organization)
			.values(ALL_ORGS.map((id) => ({ id, name: `it-sso-${id.slice(0, 8)}` })));
		await db()
			.insert(ssoProvider)
			.values([
				{
					issuer: "https://idp.example.test",
					domain: `${RUN}.example.test`,
					providerId: PROVIDER,
					userId: U.admin,
					organizationId: ORG,
					domainVerified: true,
				},
				{
					issuer: "https://idp-rev.example.test",
					domain: `rev-${RUN}.example.test`,
					providerId: PROVIDER_REVOKED,
					userId: U.admin,
					organizationId: ORG_REVOKED,
					domainVerified: true,
				},
				{
					issuer: "https://idp-unv.example.test",
					domain: `unv-${RUN}.example.test`,
					providerId: PROVIDER_UNVERIFIED,
					userId: U.admin,
					organizationId: ORG_UNVERIFIED,
					domainVerified: false,
				},
			]);

		// The sign-in account the SSO plugin links to the user for the provider they came through.
		// `unlinked` deliberately has one for ANOTHER organization's provider only.
		await db()
			.insert(account)
			.values([
				{ userId: U.fresh, accountId: `idp-${U.fresh}`, providerId: PROVIDER },
				{ userId: U.earlier, accountId: `idp-${U.earlier}`, providerId: PROVIDER },
				{ userId: U.adminRole, accountId: `idp-${U.adminRole}`, providerId: PROVIDER },
				{ userId: U.ownerRole, accountId: `idp-${U.ownerRole}`, providerId: PROVIDER },
				{ userId: U.suspended, accountId: `idp-${U.suspended}`, providerId: PROVIDER },
				{ userId: U.unlinked, accountId: `idp-${U.unlinked}`, providerId: PROVIDER_REVOKED },
				{ userId: U.revokedOrg, accountId: `idp-${U.revokedOrg}`, providerId: PROVIDER_REVOKED },
				{ userId: U.unverified, accountId: `idp-${U.unverified}`, providerId: PROVIDER_UNVERIFIED },
			]);

		// Member rows as the SSO plugin writes them: organization, user, the role `member`, a
		// creation time — no grant. `fresh` gets theirs inside the test, at "sign-in".
		const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		await db()
			.insert(member)
			.values([
				{ organizationId: ORG, userId: U.earlier, role: "member", createdAt: anHourAgo },
				{ organizationId: ORG, userId: U.adminRole, role: "admin", createdAt: anHourAgo },
				{ organizationId: ORG, userId: U.ownerRole, role: "owner", createdAt: anHourAgo },
				{
					organizationId: ORG,
					userId: U.suspended,
					role: "member",
					status: "suspended",
					createdAt: anHourAgo,
				},
				{ organizationId: ORG, userId: U.unlinked, role: "member", createdAt: anHourAgo },
				{ organizationId: ORG_REVOKED, userId: U.revokedOrg, role: "member", createdAt: anHourAgo },
				{ organizationId: ORG_UNVERIFIED, userId: U.unverified, role: "member", createdAt: anHourAgo },
			]);

		// A grant revocation as `revokeGrant` records it: it names the organization, not a subject.
		await db().insert(authzActivityLog).values({
			org_id: ORG_REVOKED,
			actor_id: U.admin,
			action: "revoke",
			resource_type: "grant",
			decision: true,
		});
	});

	afterAll(async () => {
		await db().delete(grants).where(inArray(grants.org_id, ALL_ORGS));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, ALL_ORGS));
		await db().delete(member).where(inArray(member.organizationId, ALL_ORGS));
		await db().delete(account).where(inArray(account.userId, ALL_USERS));
		await db().delete(ssoProvider).where(inArray(ssoProvider.organizationId, ALL_ORGS));
		await db().delete(organization).where(inArray(organization.id, ALL_ORGS));
		await db().delete(user).where(inArray(user.id, ALL_USERS));
	});

	it("registers the step after the SSO plugin, whose member rows it reads", () => {
		const ids = enterprisePlugins().map((p) => p.id);
		expect(ids).toContain("sso");
		expect(ids.indexOf("alethia-sso-provisioning")).toBeGreaterThan(ids.indexOf("sso"));
	});

	it("a first sign-in yields exactly one viewer grant, one seat sync and one activity row", async () => {
		// The row the SSO plugin writes for a person it has not seen in this organization.
		await db().insert(member).values({
			organizationId: ORG,
			userId: U.fresh,
			role: "member",
			createdAt: new Date(),
		});
		expect(await userGrants(ORG, U.fresh)).toEqual([]);
		expect(await canView(U.fresh, ORG)).toBe(false);
		const syncsBefore = seatSyncs(ORG);

		await signIn(U.fresh);

		expect(await userGrants(ORG, U.fresh)).toEqual([
			{
				id: expect.any(String),
				principal_type: "user",
				role_id: BUILTIN_ROLE_IDS.viewer,
				permission_key: null,
				resource_type: "org",
				resource_id: null,
				effect: "allow",
			},
		]);
		expect(await canView(U.fresh, ORG)).toBe(true);
		expect(seatSyncs(ORG) - syncsBefore).toBe(1);
		// The activity write is fire-and-forget in core, so wait for it to land.
		await vi.waitFor(async () => {
			expect(await activityOf(ORG, U.fresh)).toEqual([
				{
					action: "join",
					resource_type: "member",
					resource_id: U.fresh,
					decision: true,
					reason: expect.stringContaining("Single sign-on"),
				},
			]);
		});
	});

	it("a second sign-in adds nothing: the same grant row, no seat sync, no activity row", async () => {
		const [before] = await userGrants(ORG, U.fresh);
		if (!before) throw new Error("precondition: the first sign-in left no grant");
		const syncsBefore = seatSyncs(ORG);

		await signIn(U.fresh);
		await signIn(U.fresh, "/sso/saml2/sp/acs/:providerId");

		// The same row id: the grant was not deleted and written again.
		expect(await userGrants(ORG, U.fresh)).toEqual([before]);
		expect(seatSyncs(ORG) - syncsBefore).toBe(0);
		expect(await activityOf(ORG, U.fresh)).toHaveLength(1);
	});

	it("a member row that predates the step and has no grant is granted on its next sign-in", async () => {
		expect(await userGrants(ORG, U.earlier)).toEqual([]);
		expect(await canView(U.earlier, ORG)).toBe(false);
		const syncsBefore = seatSyncs(ORG);

		await signIn(U.earlier, "/sso/callback");

		const rows = await userGrants(ORG, U.earlier);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ role_id: BUILTIN_ROLE_IDS.viewer, resource_type: "org" });
		expect(await canView(U.earlier, ORG)).toBe(true);
		expect(seatSyncs(ORG) - syncsBefore).toBe(1);
	});

	it.each([
		["a stored role of admin", U.adminRole, ORG],
		["a stored role of owner", U.ownerRole, ORG],
		["a suspended member", U.suspended, ORG],
		["a member with no account for the organization's provider", U.unlinked, ORG],
		["an organization with a grant revocation since the member joined", U.revokedOrg, ORG_REVOKED],
		["an organization whose provider domain is not verified", U.unverified, ORG_UNVERIFIED],
	])("writes no grant for %s", async (_name, userId, orgId) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const syncsBefore = h.seatSyncs.length;

		await signIn(userId);

		expect(await userGrants(orgId, userId)).toEqual([]);
		expect(await canView(userId, orgId)).toBe(false);
		expect(h.seatSyncs.length - syncsBefore).toBe(0);
		expect(await activityOf(orgId, userId)).toEqual([]);
		warn.mockRestore();
	});

	it("the SSO plugin is configured to provision the least-privileged role and to refuse weak SAML", () => {
		const ssoPlugin = enterprisePlugins().find((p) => p.id === "sso");
		const options = prop(ssoPlugin, "options");

		expect(prop(prop(options, "organizationProvisioning"), "defaultRole")).toBe("member");
		expect(prop(prop(options, "organizationProvisioning"), "getRole")).toBeUndefined();
		expect(prop(options, "saml")).toMatchObject({
			enableInResponseToValidation: true,
			allowIdpInitiated: false,
			algorithms: { onDeprecated: "reject" },
		});
		expect(prop(prop(options, "domainVerification"), "enabled")).toBe(true);
	});
});
