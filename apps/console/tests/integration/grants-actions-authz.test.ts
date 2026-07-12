// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the access-grants SERVER ACTIONS (app/server/actions/grants.ts) gated by the
// REAL authorization stack — real authorize() → real getPdp() (community PostgresRbacPDP) →
// real grants/role/role_permission in Postgres. The mocked unit suite (tests/actions/grants.test.ts)
// stubs @/lib/authz/guard, so it can only prove the gate is CALLED; it cannot prove the PDP itself
// denies a viewer. This proves the P0 privilege-escalation fix non-vacuously: a viewer actor
// (member:view but NOT member:manage_members) is DENIED assignGrant/revokeGrant and cannot
// enumerate the access model, while an owner is allowed — with NO row written on the denied path.
//
// The actor is injected via the real actor-context seam (runWithActor), the same seam the MCP
// route uses, so the actions run unchanged under the test identity. Unique ids per run; cleaned up.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
	assignGrant,
	getGrantOptions,
	listAccessGrants,
	revokeGrant,
} from "@/app/server/actions/grants";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor, Entitlements } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	grants,
	organization,
	user,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

// Stable per-run fixture ids (unique → never collide with other rows / parallel runs).
const ORG = randomUUID();
const OWNER = randomUUID(); // holds the owner role org-wide (member:manage_members ✓)
const ADMIN = randomUUID(); // holds the admin role org-wide (manage_members ✓, but NO billing)
const VIEWER = randomUUID(); // holds the viewer role org-wide (member:view ✓, manage_members ✗)
const OUTSIDER = randomUUID(); // in the org but NO grants at all (not even member:view)
const TARGET = randomUUID(); // an innocent principal an owner may grant a role to

// customRoles=true so the ENTITLEMENT gate always passes → whatever denial we observe is the
// PDP (member:manage_members / member:view), which is precisely the escalation vector under test.
const ENTITLEMENTS: Entitlements = {
	organizations: true,
	teams: true,
	sso: true,
	customRoles: true,
	activityExport: true,
	alerting: true,
	advancedAlerting: true,
	byoRunners: true,
	managedPools: true,
	quotas: {
		maxConcurrentJobs: null,
		priorityLevel: 30,
		includedRunnerMinutes: 0,
		activityRetentionDays: 365,
	},
};

/** Builds an injected actor bound to the test org with the Enterprise entitlement. */
function actorFor(userId: string): Actor {
	return { userId, orgId: ORG, entitlements: ENTITLEMENTS };
}

/** Seeds one org-wide role grant (principal → built-in role, resource_id NULL = org-wide). */
async function seedRoleGrant(principalId: string, roleId: string): Promise<void> {
	await getServiceDb().insert(grants).values({
		org_id: ORG,
		principal_type: "user",
		principal_id: principalId,
		effect: "allow",
		role_id: roleId,
		resource_type: "org",
		resource_id: null,
	});
}

/** Counts the grants in the test org bound to `principalId` (optionally a specific role). */
async function countGrants(principalId: string, roleId?: string): Promise<number> {
	const rows = await getServiceDb()
		.select({ id: grants.id })
		.from(grants)
		.where(
			roleId
				? and(
						eq(grants.org_id, ORG),
						eq(grants.principal_id, principalId),
						eq(grants.role_id, roleId),
					)
				: and(eq(grants.org_id, ORG), eq(grants.principal_id, principalId)),
		);
	return rows.length;
}

describeIfDb("grants server actions — real PDP gate (P0 escalation fix)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// Global authz catalog (permission/role/role_permission) so the role grants resolve.
		await seedAuthz();
		await db.insert(user).values([
			{ id: OWNER, email: `it-grants-owner-${OWNER}@example.test` },
			{ id: ADMIN, email: `it-grants-admin-${ADMIN}@example.test` },
			{ id: VIEWER, email: `it-grants-viewer-${VIEWER}@example.test` },
			{ id: OUTSIDER, email: `it-grants-outsider-${OUTSIDER}@example.test` },
			{ id: TARGET, email: `it-grants-target-${TARGET}@example.test` },
		]);
		await db.insert(organization).values({ id: ORG, name: `grants-${ORG.slice(0, 8)}` });
	});

	beforeEach(async () => {
		// Base membership grants (re-seeded each test since afterEach wipes org grants).
		await seedRoleGrant(OWNER, BUILTIN_ROLE_IDS.owner);
		await seedRoleGrant(ADMIN, BUILTIN_ROLE_IDS.admin);
		await seedRoleGrant(VIEWER, BUILTIN_ROLE_IDS.viewer);
	});

	afterEach(async () => {
		await getServiceDb().delete(grants).where(eq(grants.org_id, ORG));
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(authzActivityLog).where(eq(authzActivityLog.org_id, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, [OWNER, ADMIN, VIEWER, OUTSIDER, TARGET]));
	});

	it("DENIES a viewer's self-escalation to org owner — throws ForbiddenError, writes NO row", async () => {
		await expect(
			runWithActor(actorFor(VIEWER), () =>
				assignGrant({
					principalType: "user",
					principalId: VIEWER, // grant MYSELF …
					effect: "allow",
					roleId: BUILTIN_ROLE_IDS.owner, // … the owner role, org-wide
					resourceType: "org",
				}),
			),
		).rejects.toBeInstanceOf(ForbiddenError);

		// The escalation must not have landed: no owner-role grant for the viewer.
		expect(await countGrants(VIEWER, BUILTIN_ROLE_IDS.owner)).toBe(0);
	});

	it("ALLOWS an owner to assign a grant — the row is written", async () => {
		await runWithActor(actorFor(OWNER), () =>
			assignGrant({
				principalType: "user",
				principalId: TARGET,
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.viewer,
				resourceType: "org",
			}),
		);
		expect(await countGrants(TARGET, BUILTIN_ROLE_IDS.viewer)).toBe(1);
	});

	it("DENIES a viewer revoking the owner's grant — the owner's grant survives", async () => {
		const [ownerGrant] = await getServiceDb()
			.select({ id: grants.id })
			.from(grants)
			.where(
				and(
					eq(grants.org_id, ORG),
					eq(grants.principal_id, OWNER),
					eq(grants.role_id, BUILTIN_ROLE_IDS.owner),
				),
			)
			.limit(1);

		await expect(
			runWithActor(actorFor(VIEWER), () => revokeGrant(ownerGrant.id)),
		).rejects.toBeInstanceOf(ForbiddenError);

		expect(await countGrants(OWNER, BUILTIN_ROLE_IDS.owner)).toBe(1);
	});

	it("ALLOWS an owner to revoke a grant", async () => {
		await seedRoleGrant(TARGET, BUILTIN_ROLE_IDS.viewer);
		const [g] = await getServiceDb()
			.select({ id: grants.id })
			.from(grants)
			.where(and(eq(grants.org_id, ORG), eq(grants.principal_id, TARGET)))
			.limit(1);

		await runWithActor(actorFor(OWNER), () => revokeGrant(g.id));
		expect(await countGrants(TARGET)).toBe(0);
	});

	it("a viewer CAN read the access model (member:view parity)", async () => {
		const rows = await runWithActor(actorFor(VIEWER), () => listAccessGrants());
		// The two seeded membership grants are visible to a viewer.
		expect(rows.length).toBeGreaterThanOrEqual(2);
	});

	it("DENIES an outsider (no member:view) from enumerating grants", async () => {
		await expect(
			runWithActor(actorFor(OUTSIDER), () => listAccessGrants()),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("DENIES an outsider (no member:view) from reading the grant builder options", async () => {
		await expect(
			runWithActor(actorFor(OUTSIDER), () => getGrantOptions()),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	// ── Privilege ceiling (grill finding F1) ────────────────────────────────────────────────
	// An admin holds member:manage_members, so requireAccessAdmin() passes — but the OWNER role
	// carries billing:* / org:manage_billing, which an admin does NOT hold. Without a ceiling an
	// admin could self-grant owner and gain billing. The ceiling denies any grant of a permission
	// set the grantor doesn't themselves hold.

	it("DENIES an admin self-granting the OWNER role — throws, no owner grant lands", async () => {
		await expect(
			runWithActor(actorFor(ADMIN), () =>
				assignGrant({
					principalType: "user",
					principalId: ADMIN, // grant MYSELF …
					effect: "allow",
					roleId: BUILTIN_ROLE_IDS.owner, // … the owner role (adds billing the admin lacks)
					resourceType: "org",
				}),
			),
		).rejects.toBeInstanceOf(ForbiddenError);
		expect(await countGrants(ADMIN, BUILTIN_ROLE_IDS.owner)).toBe(0);
	});

	it("DENIES an admin granting a single permission above their ceiling (billing)", async () => {
		await expect(
			runWithActor(actorFor(ADMIN), () =>
				assignGrant({
					principalType: "user",
					principalId: TARGET,
					effect: "allow",
					permissionKey: "billing:manage_billing", // admin does not hold billing
					resourceType: "org",
				}),
			),
		).rejects.toBeInstanceOf(ForbiddenError);
		expect(await countGrants(TARGET)).toBe(0);
	});

	it("ALLOWS an owner to grant the OWNER role (owner holds everything)", async () => {
		await runWithActor(actorFor(OWNER), () =>
			assignGrant({
				principalType: "user",
				principalId: TARGET,
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.owner,
				resourceType: "org",
			}),
		);
		expect(await countGrants(TARGET, BUILTIN_ROLE_IDS.owner)).toBe(1);
	});

	it("ALLOWS an admin to grant a SUBSET role (viewer ⊆ admin)", async () => {
		await runWithActor(actorFor(ADMIN), () =>
			assignGrant({
				principalType: "user",
				principalId: TARGET,
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.viewer,
				resourceType: "org",
			}),
		);
		expect(await countGrants(TARGET, BUILTIN_ROLE_IDS.viewer)).toBe(1);
	});
});
