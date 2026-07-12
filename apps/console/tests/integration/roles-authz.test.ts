// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the custom-role SERVER ACTIONS (app/server/actions/roles.ts) gated by the REAL
// authorization stack — real authorizeQuiet() → real getPdp() (community PostgresRbacPDP) → real
// grants/role/role_permission in Postgres. The mocked unit suite (tests/actions/roles.test.ts) stubs
// @/lib/authz/guard, so it can only prove the gate is CALLED; it cannot prove the PDP itself denies a
// member. This proves the P1 escalation fix non-vacuously: an operator actor (holds a built-in role
// but NOT member:manage_members) is DENIED create/update/deleteRole and CANNOT rewrite or destroy the
// org's roles — nor self-grant every permission by rewriting a role's key set — while an owner is
// allowed, with the target role's permission rows UNCHANGED on the denied path.
//
// The actor is injected via the real actor-context seam (runWithActor), the same seam the MCP route
// uses, so the actions run unchanged under the test identity. Unique ids per run; cleaned up.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
	createRole,
	deleteRole,
	updateRole,
} from "@/app/server/actions/roles";
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
	role,
	rolePermission,
	user,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

// Stable per-run fixture ids (unique → never collide with other rows / parallel runs).
const ORG = randomUUID();
const OWNER = randomUUID(); // holds the owner role org-wide (member:manage_members ✓)
const OPERATOR = randomUUID(); // holds the operator role org-wide (manage_members ✗, member:view ✗)

// customRoles=true so the ENTITLEMENT gate always passes → whatever denial we observe is the PDP
// (member:manage_members), which is precisely the escalation vector under test.
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

/** The permission keys currently attached to a role, sorted for stable comparison. */
async function permKeysOf(roleId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ key: rolePermission.permission_key })
		.from(rolePermission)
		.where(eq(rolePermission.role_id, roleId));
	return rows.map((r) => r.key).sort();
}

/** True when a role row with this id still exists in the org. */
async function roleExists(roleId: string): Promise<boolean> {
	const rows = await getServiceDb()
		.select({ id: role.id })
		.from(role)
		.where(and(eq(role.id, roleId), eq(role.organization_id, ORG)))
		.limit(1);
	return rows.length === 1;
}

describeIfDb("custom-role server actions — real PDP gate (P1 escalation fix)", () => {
	// A custom role seeded fresh per test (afterEach wipes it) with a known permission set.
	let customRoleId: string;

	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // global permission/role/role_permission catalog so grants resolve
		await db.insert(user).values([
			{ id: OWNER, email: `it-roles-owner-${OWNER}@example.test` },
			{ id: OPERATOR, email: `it-roles-operator-${OPERATOR}@example.test` },
		]);
		await db.insert(organization).values({ id: ORG, name: `roles-${ORG.slice(0, 8)}` });
	});

	beforeEach(async () => {
		const db = getServiceDb();
		// Membership grants (re-seeded each test since afterEach wipes org grants).
		await seedRoleGrant(OWNER, BUILTIN_ROLE_IDS.owner);
		await seedRoleGrant(OPERATOR, BUILTIN_ROLE_IDS.operator);
		// A custom (non-built-in) role with a known key set.
		customRoleId = randomUUID();
		await db
			.insert(role)
			.values({ id: customRoleId, organization_id: ORG, name: "Auditor", is_builtin: false });
		await db
			.insert(rolePermission)
			.values([
				{ role_id: customRoleId, permission_key: "org:view" },
				{ role_id: customRoleId, permission_key: "project:view" },
			]);
	});

	afterEach(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		// role_permission cascades from role; delete any custom roles left in the org.
		await db.delete(role).where(and(eq(role.organization_id, ORG), eq(role.is_builtin, false)));
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(role).where(eq(role.organization_id, ORG));
		await db.delete(authzActivityLog).where(eq(authzActivityLog.org_id, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, [OWNER, OPERATOR]));
	});

	it("DENIES an operator rewriting a role's permission set — throws, keys UNCHANGED", async () => {
		await expect(
			runWithActor(actorFor(OPERATOR), () =>
				// The escalation: rewrite the role to hold EVERY permission.
				updateRole(customRoleId, "Pwned", ["org:view", "org:manage_billing", "member:manage_members"]),
			),
		).rejects.toBeInstanceOf(ForbiddenError);

		// The role's permissions must be exactly what we seeded — no escalation landed.
		expect(await permKeysOf(customRoleId)).toEqual(["org:view", "project:view"]);
	});

	it("DENIES an operator deleting a role — throws, the role survives", async () => {
		await expect(
			runWithActor(actorFor(OPERATOR), () => deleteRole(customRoleId)),
		).rejects.toBeInstanceOf(ForbiddenError);
		expect(await roleExists(customRoleId)).toBe(true);
	});

	it("DENIES an operator creating a role — throws, no role added", async () => {
		await expect(
			runWithActor(actorFor(OPERATOR), () => createRole("Sneaky", ["org:view"])),
		).rejects.toBeInstanceOf(ForbiddenError);
		// Only the seeded custom role exists in the org.
		const rows = await getServiceDb()
			.select({ id: role.id })
			.from(role)
			.where(and(eq(role.organization_id, ORG), eq(role.is_builtin, false)));
		expect(rows).toHaveLength(1);
	});

	it("ALLOWS an owner to rewrite a role's permissions", async () => {
		await runWithActor(actorFor(OWNER), () =>
			updateRole(customRoleId, "Renamed", ["runner:view"]),
		);
		expect(await permKeysOf(customRoleId)).toEqual(["runner:view"]);
	});

	it("ALLOWS an owner to delete a role", async () => {
		await runWithActor(actorFor(OWNER), () => deleteRole(customRoleId));
		expect(await roleExists(customRoleId)).toBe(false);
	});
});
