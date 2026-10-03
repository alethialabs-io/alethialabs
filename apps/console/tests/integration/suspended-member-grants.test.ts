// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#5465): a member who is not active holds no grant, and a role change cannot take an
// org's last ACTIVE owner away — both against real Postgres and the real community PDP.
//
// The defect: the ee `afterUpdateMemberRole` hook calls `ensureMemberGrant` on every role change,
// and `ensureMemberGrant` wrote the grant whatever `member.status` said. So promoting a suspended
// member put a grant row back and the PDP (which reads grants, never `member.status`) let them in.
// Against the previous head the first case below finds that row and an allowed decision.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	LAST_ACTIVE_OWNER_MESSAGE,
	roleChangeOwnerRefusal,
} from "@/lib/authz/active-owner";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import { grants, member, organization, user } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const U = {
	owner: randomUUID(), // the one ACTIVE owner
	suspendedOwner: randomUUID(), // an owner, suspended
	suspended: randomUUID(), // a viewer, suspended — the member the issue promotes
	active: randomUUID(), // an active admin — the control
};
const M = {
	owner: randomUUID(),
	suspendedOwner: randomUUID(),
	suspended: randomUUID(),
	active: randomUUID(),
};
const ALL_USERS = Object.values(U);

const pdp = new PostgresRbacPDP();

/** Can this user view projects in ORG, per the real community PDP? */
async function canView(userId: string): Promise<boolean> {
	return (await pdp.can({ userId, orgId: ORG }, "view", { type: "project" })).allowed;
}

/** The user's grant rows in ORG. */
async function userGrants(userId: string) {
	return getServiceDb()
		.select({ role_id: grants.role_id })
		.from(grants)
		.where(and(eq(grants.org_id, ORG), eq(grants.principal_id, userId)));
}

describeIfDb("#5465 — suspended members hold no grant; an org keeps an active owner", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // the built-in role rows grants.role_id references
		await db
			.insert(user)
			.values(ALL_USERS.map((id) => ({ id, email: `it-5465-${id}@example.test` })));
		await db.insert(organization).values({ id: ORG, name: `it-5465-${ORG.slice(0, 8)}` });
		await db.insert(member).values([
			{ id: M.owner, organizationId: ORG, userId: U.owner, role: "owner" },
			{
				id: M.suspendedOwner,
				organizationId: ORG,
				userId: U.suspendedOwner,
				role: "owner",
				status: "suspended",
			},
			{
				id: M.suspended,
				organizationId: ORG,
				userId: U.suspended,
				role: "viewer",
				status: "suspended",
			},
			{ id: M.active, organizationId: ORG, userId: U.active, role: "admin" },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, ALL_USERS));
	});

	it("promoting a SUSPENDED member writes no grant and the PDP keeps denying them; reactivating grants them", async () => {
		// What `afterUpdateMemberRole` does after better-auth stores the new role.
		await getServiceDb()
			.update(member)
			.set({ role: "admin" })
			.where(eq(member.id, M.suspended));
		await ensureMemberGrant(ORG, U.suspended, "admin");

		expect(await userGrants(U.suspended)).toEqual([]);
		expect(await canView(U.suspended)).toBe(false);

		// Reactivation (setMemberSuspended(false)): the status flips first, then the same writer.
		await getServiceDb()
			.update(member)
			.set({ status: "active" })
			.where(eq(member.id, M.suspended));
		await ensureMemberGrant(ORG, U.suspended, "admin");

		expect(await userGrants(U.suspended)).toEqual([{ role_id: BUILTIN_ROLE_IDS.admin }]);
		expect(await canView(U.suspended)).toBe(true);
	});

	it("an active member's role change still replaces their grant (the control)", async () => {
		await ensureMemberGrant(ORG, U.active, "admin");
		await ensureMemberGrant(ORG, U.active, "operator");
		expect(await userGrants(U.active)).toEqual([{ role_id: BUILTIN_ROLE_IDS.operator }]);
	});

	it("refuses demoting the only ACTIVE owner even though a suspended owner exists, and allows it once another active member is an owner", async () => {
		// better-auth's own check counts the suspended owner and would let this through.
		expect(await roleChangeOwnerRefusal(ORG, M.owner, "admin")).toBe(
			LAST_ACTIVE_OWNER_MESSAGE,
		);
		// Demoting the SUSPENDED owner changes no active owner.
		expect(await roleChangeOwnerRefusal(ORG, M.suspendedOwner, "viewer")).toBeNull();

		// A comma-joined role with an owner part is an owner, as `toPdpRole` reads it.
		await getServiceDb()
			.update(member)
			.set({ role: "admin,owner" })
			.where(eq(member.id, M.active));
		expect(await roleChangeOwnerRefusal(ORG, M.owner, "admin")).toBeNull();
	});
});
