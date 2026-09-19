// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the #3754 operator command (scripts/grant-ungranted-members.ts) against real
// Postgres. It lists members the `toOrgRole` gap left with no grant and grants each only on an
// explicit confirmation — so the assertions that matter are about what it does NOT do:
//
//  * a member whose grant was REVOKED is not re-granted by `--yes` (the issue's named test: the
//    happy path proves nothing about the failure mode this command exists to guard), nor by an
//    operator who answers "n";
//  * suspended members, members holding any user grant (org-wide or scoped) are never listed;
//  * a row that changed between listing and granting is skipped, not overwritten.
//
// And one thing it must do: a granted member is authorized by the real PostgresRbacPDP afterwards,
// because the grant went through `ensureMemberGrant`, the app's own write path.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	grants,
	member,
	organization,
	user,
} from "@/lib/db/schema";
import {
	grantIfStillUngranted,
	listUngrantedMembers,
	runGrantPass,
	type UngrantedMember,
} from "../../scripts/grant-ungranted-members";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

const ORG = randomUUID(); // no revocation recorded in it
const ORG_REVOKED = randomUUID(); // one grant revocation recorded after its member joined
const PROJECT = randomUUID(); // a scope id for the scoped-grant control; need not resolve

const U = {
	gap: randomUUID(), // role 'member', no grant — the #3744 population
	gapAdmin: randomUUID(), // role 'admin', no grant — the SSO JIT shape (hooks never fired)
	granted: randomUUID(), // holds an org-wide grant — control
	scoped: randomUUID(), // holds only a scoped user grant — someone set their access
	suspended: randomUUID(), // suspended: revoked by design, never listed
	unmappable: randomUUID(), // a role no PDP role maps from
	revoked: randomUUID(), // in ORG_REVOKED; granted, then revoked like revokeGrant does
};
const ALL_USERS = Object.values(U);

const pdp = new PostgresRbacPDP();

/** Can this user view projects in this org, per the real community PDP? */
async function canView(userId: string, orgId: string): Promise<boolean> {
	return (await pdp.can({ userId, orgId }, "view", { type: "project" })).allowed;
}

/** The user's grant rows in one org, as the columns an org-wide member grant is made of. */
async function userGrants(orgId: string, userId: string) {
	return getServiceDb()
		.select({
			role_id: grants.role_id,
			resource_type: grants.resource_type,
			resource_id: grants.resource_id,
			effect: grants.effect,
		})
		.from(grants)
		.where(and(eq(grants.org_id, orgId), eq(grants.principal_id, userId)));
}

/** Rows the command lists for one org, keyed by user id for readable assertions. */
async function listedUserIds(orgId: string): Promise<string[]> {
	const rows = await listUngrantedMembers(getServiceDb(), orgId);
	return rows.map((r) => r.user_id).sort();
}

describeIfDb("the #3754 grant-ungranted-members operator command", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // the built-in role rows grants.role_id references

		await db.insert(user).values(
			ALL_USERS.map((id) => ({ id, email: `it-ungranted-${id}@example.test` })),
		);
		await db.insert(organization).values([
			{ id: ORG, name: `ungranted-${ORG.slice(0, 8)}` },
			{ id: ORG_REVOKED, name: `ungranted-rev-${ORG_REVOKED.slice(0, 8)}` },
		]);
		// Joined an hour ago, so an activity row written now is unambiguously "since join".
		const joined = new Date(Date.now() - 60 * 60 * 1000);
		await db.insert(member).values([
			{ organizationId: ORG, userId: U.gap, role: "member", createdAt: joined },
			{ organizationId: ORG, userId: U.gapAdmin, role: "admin", createdAt: joined },
			{ organizationId: ORG, userId: U.granted, role: "operator", createdAt: joined },
			{ organizationId: ORG, userId: U.scoped, role: "member", createdAt: joined },
			{ organizationId: ORG, userId: U.suspended, role: "member", status: "suspended", createdAt: joined },
			{ organizationId: ORG, userId: U.unmappable, role: "auditor-typo", createdAt: joined },
			{ organizationId: ORG_REVOKED, userId: U.revoked, role: "member", createdAt: joined },
		]);
		await db.insert(grants).values([
			{
				org_id: ORG,
				principal_type: "user",
				principal_id: U.granted,
				role_id: BUILTIN_ROLE_IDS.operator,
				resource_type: "org",
			},
			{
				org_id: ORG,
				principal_type: "user",
				principal_id: U.scoped,
				permission_key: "project:view",
				resource_type: "project",
				resource_id: PROJECT,
			},
		]);

		// The revoked member: granted by the app's path, then revoked exactly as revokeGrant
		// (app/server/actions/grants.ts) does it — the row deleted, member.role left intact, and an
		// activity row that names the org but NOT the subject.
		await ensureMemberGrant(ORG_REVOKED, U.revoked, "member");
		expect(await canView(U.revoked, ORG_REVOKED)).toBe(true);
		await db.delete(grants).where(eq(grants.org_id, ORG_REVOKED));
		await db.insert(authzActivityLog).values({
			org_id: ORG_REVOKED,
			actor_id: U.revoked,
			action: "revoke",
			resource_type: "grant",
			decision: true,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(inArray(grants.org_id, [ORG, ORG_REVOKED]));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG, ORG_REVOKED]));
		await db.delete(member).where(inArray(member.organizationId, [ORG, ORG_REVOKED]));
		await db.delete(organization).where(inArray(organization.id, [ORG, ORG_REVOKED]));
		await db.delete(user).where(inArray(user.id, ALL_USERS));
	});

	it("lists exactly the active members with no user grant — not the granted, scoped or suspended", async () => {
		expect(await listedUserIds(ORG)).toEqual([U.gap, U.gapAdmin, U.unmappable].sort());
		expect(await listedUserIds(ORG_REVOKED)).toEqual([U.revoked]);
		// And the gap is real before the command runs: the PDP denies them.
		expect(await canView(U.gap, ORG)).toBe(false);
	});

	it("shows the org-level revocation evidence the log holds, and none where there is none", async () => {
		const [revoked] = await listUngrantedMembers(getServiceDb(), ORG_REVOKED);
		expect(revoked?.org_revocations_since_join).toBe(1);
		expect(revoked?.last_org_revocation).not.toBeNull();
		for (const row of await listUngrantedMembers(getServiceDb(), ORG)) {
			expect(row.org_revocations_since_join).toBe(0);
		}
	});

	it("a REVOKED member is not re-granted by --yes, and not by an operator who answers n", async () => {
		const db = getServiceDb();
		const rows = await listUngrantedMembers(db, ORG_REVOKED);
		const confirm = vi.fn(async () => true);

		const yes = await runGrantPass({ db, rows, yes: true, confirm });
		expect(yes).toEqual(["held"]);
		expect(confirm).not.toHaveBeenCalled(); // --yes never asks, and never grants a held row

		const declined = await runGrantPass({ db, rows, yes: false, confirm: async () => false });
		expect(declined).toEqual(["declined"]);

		expect(await listedUserIds(ORG_REVOKED)).toEqual([U.revoked]);
		expect(await canView(U.revoked, ORG_REVOKED)).toBe(false);
	});

	it("asks per row interactively, never about an unmappable role, and grants only the yes", async () => {
		const db = getServiceDb();
		const rows = await listUngrantedMembers(db, ORG);
		const asked: string[] = [];
		const outcomes = await runGrantPass({
			db,
			rows,
			yes: false,
			confirm: async (row: UngrantedMember) => {
				asked.push(row.user_id);
				return row.user_id === U.gapAdmin;
			},
		});
		expect(asked.sort()).toEqual([U.gap, U.gapAdmin].sort());
		const byUser = new Map(rows.map((r, i) => [r.user_id, outcomes[i]]));
		expect(byUser.get(U.gapAdmin)).toBe("granted");
		expect(byUser.get(U.gap)).toBe("declined");
		expect(byUser.get(U.unmappable)).toBe("unmappable");
		expect(await canView(U.gap, ORG)).toBe(false);
		expect(await listedUserIds(ORG)).toEqual([U.gap, U.unmappable].sort());
	});

	it("--yes grants a clear row through ensureMemberGrant: the app's org-wide row, and the PDP allows", async () => {
		const db = getServiceDb();
		const rows = await listUngrantedMembers(db, ORG);
		const outcomes = await runGrantPass({ db, rows, yes: true, confirm: async () => false });
		const byUser = new Map(rows.map((r, i) => [r.user_id, outcomes[i]]));
		expect(byUser.get(U.gap)).toBe("granted");
		expect(byUser.get(U.unmappable)).toBe("unmappable");

		const written = await userGrants(ORG, U.gap);
		// `member` is Better Auth's default role and means viewer (MEMBERSHIP_ROLE_ALIASES).
		expect(written).toEqual([
			{ role_id: BUILTIN_ROLE_IDS.viewer, resource_type: "org", resource_id: null, effect: "allow" },
		]);
		expect(await canView(U.gap, ORG)).toBe(true);

		// Idempotent: a re-run lists only what is still ungranted.
		expect(await listedUserIds(ORG)).toEqual([U.unmappable]);
		expect(await userGrants(ORG, U.unmappable)).toEqual([]);
	});

	it("a stale row is skipped, not written over: already granted, role changed, suspended", async () => {
		const db = getServiceDb();
		const grant = vi.fn(ensureMemberGrant);
		const stale: UngrantedMember = {
			member_id: "",
			org_id: ORG,
			org_name: "",
			user_id: U.gap,
			email: "",
			role: "member",
			created_at: "",
			team_grants: 0,
			org_revocations_since_join: 0,
			last_org_revocation: null,
		};
		const [gapMember] = await db
			.select({ id: member.id })
			.from(member)
			.where(eq(member.userId, U.gap));
		if (!gapMember) throw new Error("fixture member missing");
		stale.member_id = gapMember.id;

		// U.gap was granted by the previous case; the listing that produced `stale` predates it.
		expect(await grantIfStillUngranted(db, stale, grant)).toBe("already-granted");

		const [unmappable] = await db
			.select({ id: member.id })
			.from(member)
			.where(eq(member.userId, U.unmappable));
		if (!unmappable) throw new Error("fixture member missing");
		const roleChanged = { ...stale, member_id: unmappable.id, user_id: U.unmappable, role: "viewer" };
		expect(await grantIfStillUngranted(db, roleChanged, grant)).toBe("role-changed");

		const [suspended] = await db
			.select({ id: member.id })
			.from(member)
			.where(eq(member.userId, U.suspended));
		if (!suspended) throw new Error("fixture member missing");
		const wasActive = { ...stale, member_id: suspended.id, user_id: U.suspended };
		expect(await grantIfStillUngranted(db, wasActive, grant)).toBe("suspended");

		expect(await grantIfStillUngranted(db, { ...stale, member_id: randomUUID() }, grant)).toBe("gone");

		expect(grant).not.toHaveBeenCalled();
		expect(await canView(U.suspended, ORG)).toBe(false);
	});
});
