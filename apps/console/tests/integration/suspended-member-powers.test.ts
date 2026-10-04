// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#5472): a member who is not active keeps no power in the org, against real Postgres
// and the real community PDP.
//
// Each case is a defect on the previous head:
//   - the PDP resolved a TEAM grant through `team_member` without reading `member.status`, so a
//     suspended member still reached everything their team was granted;
//   - better-auth's leave and remove counted a suspended owner as an owner, so the last ACTIVE
//     owner could go (`removalOwnerRefusal` and the auth route's leave guard);
//   - a suspended member could be made an owner (`roleChangeOwnerRefusal` returned null for any
//     change TO owner);
//   - better-auth authorized invite from `member.role` alone, so a suspended admin could invite;
//   - `ensureMemberGrant` granted a user with no member row in a real org, which is a removed user.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { orgActionRefusal } from "@/app/api/auth/[...all]/member-guards";
import {
	INACTIVE_OWNER_MESSAGE,
	LAST_ACTIVE_OWNER_MESSAGE,
	removalOwnerRefusal,
	roleChangeOwnerRefusal,
} from "@/lib/authz/active-owner";
import { ensureMemberGrant, isNonActiveMember } from "@/lib/authz/grants";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import { grants, member, organization, team, teamMember, user } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const TEAM = randomUUID();
const U = {
	owner: randomUUID(), // the one ACTIVE owner
	suspendedOwner: randomUUID(), // an owner, suspended (a row from before #5465 refused that)
	suspended: randomUUID(), // a suspended admin on the team
	active: randomUUID(), // an active viewer on the team — the control
	removed: randomUUID(), // a user with no member row in ORG
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

/** The user's grant rows in an org. */
async function userGrants(orgId: string, userId: string) {
	return getServiceDb()
		.select({ role_id: grants.role_id })
		.from(grants)
		.where(and(eq(grants.org_id, orgId), eq(grants.principal_id, userId)));
}

describeIfDb("#5472 — a member who is not active keeps no power in the org", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // the built-in role rows grants.role_id references
		await db
			.insert(user)
			.values(ALL_USERS.map((id) => ({ id, email: `it-5472-${id}@example.test` })));
		await db.insert(organization).values({ id: ORG, name: `it-5472-${ORG.slice(0, 8)}` });
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
				role: "admin",
				status: "suspended",
			},
			{ id: M.active, organizationId: ORG, userId: U.active, role: "viewer" },
		]);
		await db.insert(team).values({ id: TEAM, name: "platform", organizationId: ORG });
		await db.insert(teamMember).values([
			{ teamId: TEAM, userId: U.suspended },
			{ teamId: TEAM, userId: U.active },
			// A removed user whose `team_member` row outlived their member row (the CLI member
			// DELETE removes only the member row).
			{ teamId: TEAM, userId: U.removed },
		]);
		// The team's org-wide viewer grant: suspension never touches a TEAM principal's row.
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "team",
			principal_id: TEAM,
			role_id: BUILTIN_ROLE_IDS.viewer,
			resource_type: "org",
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(inArray(grants.org_id, [ORG, U.removed]));
		await db.delete(teamMember).where(eq(teamMember.teamId, TEAM));
		await db.delete(team).where(eq(team.id, TEAM));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, ALL_USERS));
	});

	it("does not honour a team grant, nor a leftover user grant, for a suspended member; an active teammate is allowed", async () => {
		expect(await canView(U.suspended)).toBe(false);
		expect(await pdp.listAccessible({ userId: U.suspended, orgId: ORG }, "view", "project")).toEqual(
			[],
		);

		// A user grant that outlived the suspension (written between the status read and the
		// insert of a grant API, say) is not honoured either.
		await getServiceDb().insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: U.suspended,
			role_id: BUILTIN_ROLE_IDS.admin,
			resource_type: "org",
		});
		expect(await canView(U.suspended)).toBe(false);

		expect(await canView(U.active)).toBe(true);
	});

	it("refuses removing or letting go of the only ACTIVE owner while a suspended owner remains", async () => {
		expect(await removalOwnerRefusal(ORG, M.owner)).toBe(LAST_ACTIVE_OWNER_MESSAGE);
		expect(await removalOwnerRefusal(ORG, M.suspendedOwner)).toBeNull();

		const leave = await orgActionRefusal("leave", { organizationId: ORG }, U.owner, undefined);
		expect(leave?.status).toBe(400);
		expect(await leave?.json()).toEqual({
			code: "ORGANIZATION_NEEDS_AN_ACTIVE_OWNER",
			message: LAST_ACTIVE_OWNER_MESSAGE,
		});
		// The control: a member who is not the last active owner may leave.
		expect(await orgActionRefusal("leave", { organizationId: ORG }, U.active, undefined)).toBeNull();
	});

	it("refuses making a suspended member an owner, and allows it for an active one", async () => {
		expect(await roleChangeOwnerRefusal(ORG, M.suspended, "owner")).toBe(INACTIVE_OWNER_MESSAGE);
		expect(await roleChangeOwnerRefusal(ORG, M.active, "owner")).toBeNull();
	});

	it("refuses member management from a suspended admin, in the org the body names or the session's active one", async () => {
		const named = await orgActionRefusal(
			"invite-member",
			{ organizationId: ORG, email: "x@example.test", role: "admin" },
			U.suspended,
			undefined,
		);
		expect(named?.status).toBe(403);
		const active = await orgActionRefusal(
			"update-member-role",
			{ memberId: M.active, role: "admin" },
			U.suspended,
			ORG,
		);
		expect(active?.status).toBe(403);
		// The control: the active owner is not refused.
		expect(
			await orgActionRefusal("invite-member", { organizationId: ORG }, U.owner, undefined),
		).toBeNull();
	});

	it("writes no grant for a user with no member row in the org, and still grants their personal scope", async () => {
		expect(await isNonActiveMember(ORG, U.suspended)).toBe(true);
		expect(await isNonActiveMember(ORG, U.removed)).toBe(false);

		await ensureMemberGrant(ORG, U.removed, "admin");
		expect(await userGrants(ORG, U.removed)).toEqual([]);

		await ensureMemberGrant(U.removed, U.removed, "owner");
		expect(await userGrants(U.removed, U.removed)).toEqual([
			{ role_id: BUILTIN_ROLE_IDS.owner },
		]);
	});

	// Both PDPs now deny an actor with NO member row outside their personal scope. Before, the
	// Postgres engine refused only the team grant for such an actor and the OpenFGA engine refused
	// nothing, so a removed user still on a team kept the team's access there.
	it("grants a user with no member row nothing in the org — not their team's grant, not a leftover user grant — and still everything in their personal scope", async () => {
		expect(await canView(U.removed)).toBe(false);
		await getServiceDb().insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: U.removed,
			role_id: BUILTIN_ROLE_IDS.admin,
			resource_type: "org",
		});
		expect(await canView(U.removed)).toBe(false);
		expect(
			await pdp.listAccessible({ userId: U.removed, orgId: ORG }, "view", "project"),
		).toEqual([]);

		// The personal scope (org id = user id) has no member row by design.
		await ensureMemberGrant(U.removed, U.removed, "owner");
		expect(
			(await pdp.can({ userId: U.removed, orgId: U.removed }, "view", { type: "project" }))
				.allowed,
		).toBe(true);
	});
});
