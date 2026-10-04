// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#5484): the suspended- and removed-member paths #5472's review left open, against
// real Postgres and the real community PDP. Each case is a defect on the previous head:
//   - the CLI member DELETE removed the member row and left the user's `team_member` rows, so a
//     re-added user got their old team memberships back, and with them the team's grants;
//   - a removed admin's pending invitations stayed pending;
//   - the SSO provider endpoints authorize from `member.role` alone, so a suspended admin could
//     still change the org's identity providers;
//   - the console URL resolved a suspended member onto the org; with the enterprise scope resolver
//     now skipping a suspended row, that disagreement threw out of every reader on the page.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ path: "" }));

// The CLI route's credential and org checks are not under test; the writes after them are.
vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: async () => ({ actor: { userId: "cli-actor", orgId: "cli-org" }, credential: {} }),
	ensureCliOrgAccess: async () => null,
}));
// The path the proxy publishes for the request, which `urlScopedOrgId` reads its org from.
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": h.path }),
}));

import { ssoActionRefusal } from "@/app/api/auth/[...all]/member-guards";
import { DELETE } from "@/app/api/cli/orgs/[id]/members/[memberId]/route";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { urlScopedOrgId } from "@/lib/authz/org-scope";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import {
	grants,
	invitation,
	member,
	organization,
	ssoProvider,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const SLUG = `it-5484-${ORG.slice(0, 8)}`;
const TEAM = randomUUID();
const OTHER_TEAM = randomUUID();
const PROVIDER = `it-5484-${randomUUID()}`;
const U = {
	owner: randomUUID(), // the ACTIVE owner — the control throughout
	removed: randomUUID(), // an active admin, on TEAM, removed through the CLI below
	teammate: randomUUID(), // an active viewer on TEAM — the control for the team grant
	suspended: randomUUID(), // a suspended admin
};
const M = {
	owner: randomUUID(),
	removed: randomUUID(),
	teammate: randomUUID(),
	suspended: randomUUID(),
};
const INVITE = { removed: randomUUID(), owner: randomUUID(), otherOrg: randomUUID() };
const ALL_USERS = Object.values(U);

const pdp = new PostgresRbacPDP();

/**
 * Can this user manage ORG's members, per the real community PDP? For a member whose own role is
 * viewer, only the team's admin grant allows it.
 */
async function canManageMembers(userId: string): Promise<boolean> {
	return (await pdp.can({ userId, orgId: ORG }, "manage_members", { type: "member" })).allowed;
}

/** An invitation's status. */
async function invitationStatus(id: string): Promise<string | undefined> {
	const [row] = await getServiceDb()
		.select({ status: invitation.status })
		.from(invitation)
		.where(eq(invitation.id, id));
	return row?.status;
}

/** The team ids `userId` has a `team_member` row in, among TEAM and OTHER_TEAM. */
async function teamsOf(userId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ teamId: teamMember.teamId })
		.from(teamMember)
		.where(and(eq(teamMember.userId, userId), inArray(teamMember.teamId, [TEAM, OTHER_TEAM])));
	return rows.map((r) => r.teamId);
}

/** A team's `memberCount`. */
async function memberCount(teamId: string): Promise<number | undefined> {
	const [row] = await getServiceDb()
		.select({ memberCount: team.memberCount })
		.from(team)
		.where(eq(team.id, teamId));
	return row?.memberCount;
}

/** Calls the CLI route the way `alethia orgs members remove` does. */
function cliRemove(memberId: string): Promise<Response> {
	return DELETE(
		new Request(`https://console.local/api/cli/orgs/${ORG}/members/${memberId}`, {
			method: "DELETE",
		}),
		{ params: Promise.resolve({ id: ORG, memberId }) },
	);
}

describeIfDb("#5484 — what a suspended or removed member keeps", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // the built-in role rows grants.role_id references
		await db
			.insert(user)
			.values(ALL_USERS.map((id) => ({ id, email: `it-5484-${id}@example.test` })));
		await db.insert(organization).values([
			{ id: ORG, name: SLUG, slug: SLUG },
			{ id: OTHER_ORG, name: `it-5484-other-${OTHER_ORG.slice(0, 8)}` },
		]);
		await db.insert(member).values([
			{ id: M.owner, organizationId: ORG, userId: U.owner, role: "owner" },
			{ id: M.removed, organizationId: ORG, userId: U.removed, role: "admin" },
			{ id: M.teammate, organizationId: ORG, userId: U.teammate, role: "viewer" },
			{
				id: M.suspended,
				organizationId: ORG,
				userId: U.suspended,
				role: "admin",
				status: "suspended",
			},
			// The removed user is in another org too; nothing there may move.
			{ organizationId: OTHER_ORG, userId: U.removed, role: "admin" },
		]);
		await db.insert(team).values([
			{ id: TEAM, name: "platform", organizationId: ORG, memberCount: 2 },
			{ id: OTHER_TEAM, name: "platform", organizationId: OTHER_ORG, memberCount: 1 },
		]);
		await db.insert(teamMember).values([
			{ teamId: TEAM, userId: U.removed },
			{ teamId: TEAM, userId: U.teammate },
			{ teamId: OTHER_TEAM, userId: U.removed },
		]);
		// The team's org-wide ADMIN grant: more than the viewer role a re-invited user comes back as.
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "team",
			principal_id: TEAM,
			role_id: BUILTIN_ROLE_IDS.admin,
			resource_type: "org",
		});
		const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
		await db.insert(invitation).values([
			{
				id: INVITE.removed,
				organizationId: ORG,
				email: "second-account@example.test",
				role: "admin",
				inviterId: U.removed,
				expiresAt,
			},
			{
				id: INVITE.owner,
				organizationId: ORG,
				email: "colleague@example.test",
				role: "viewer",
				inviterId: U.owner,
				expiresAt,
			},
			{
				id: INVITE.otherOrg,
				organizationId: OTHER_ORG,
				email: "elsewhere@example.test",
				role: "viewer",
				inviterId: U.removed,
				expiresAt,
			},
		]);
		await db.insert(ssoProvider).values({
			issuer: "https://idp.example.test",
			domain: "example.test",
			providerId: PROVIDER,
			userId: U.owner,
			organizationId: ORG,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(ssoProvider).where(eq(ssoProvider.providerId, PROVIDER));
		await db.delete(invitation).where(inArray(invitation.organizationId, [ORG, OTHER_ORG]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(teamMember).where(inArray(teamMember.teamId, [TEAM, OTHER_TEAM]));
		await db.delete(team).where(inArray(team.id, [TEAM, OTHER_TEAM]));
		await db.delete(member).where(inArray(member.organizationId, [ORG, OTHER_ORG]));
		await db.delete(organization).where(inArray(organization.id, [ORG, OTHER_ORG]));
		await db.delete(user).where(inArray(user.id, ALL_USERS));
	});

	it("the CLI member DELETE takes the user's team rows in the org with it, so a re-added user does not get the team's grant back", async () => {
		// The team grant reaches both teammates before the removal.
		expect(await canManageMembers(U.removed)).toBe(true);

		const res = await cliRemove(M.removed);
		expect(res.status).toBe(200);

		// Re-invited and accepted as a viewer: the member row comes back with its own viewer grant.
		await getServiceDb()
			.insert(member)
			.values({ organizationId: ORG, userId: U.removed, role: "viewer" });
		await ensureMemberGrant(ORG, U.removed, "viewer");
		expect(await canManageMembers(U.removed)).toBe(false);
		// The control: the teammate who stayed still has the team's grant.
		expect(await canManageMembers(U.teammate)).toBe(true);

		// The rows themselves: gone from ORG's team (its count follows), kept in the other org's.
		expect(await teamsOf(U.removed)).toEqual([OTHER_TEAM]);
		expect(await memberCount(TEAM)).toBe(1);
		expect(await memberCount(OTHER_TEAM)).toBe(1);
	});

	it("the CLI member DELETE cancels the invitations the removed member sent into that org, and no one else's", async () => {
		// Removed in the case above.
		expect(await invitationStatus(INVITE.removed)).toBe("canceled");
		expect(await invitationStatus(INVITE.owner)).toBe("pending");
		expect(await invitationStatus(INVITE.otherOrg)).toBe("pending");
	});

	it("refuses SSO provider changes from a suspended admin, in the org the body names or the provider belongs to; an active owner is not refused", async () => {
		const register = await ssoActionRefusal(
			"register",
			{ organizationId: ORG, providerId: "new", issuer: "https://idp.example.test" },
			U.suspended,
		);
		expect(register?.status).toBe(403);
		expect(await register?.json()).toMatchObject({ code: "MEMBER_NOT_ACTIVE" });
		for (const action of [
			"update-provider",
			"delete-provider",
			"request-domain-verification",
			"verify-domain",
		]) {
			expect((await ssoActionRefusal(action, { providerId: PROVIDER }, U.suspended))?.status).toBe(
				403,
			);
		}

		// The controls.
		expect(await ssoActionRefusal("register", { organizationId: ORG }, U.owner)).toBeNull();
		expect(await ssoActionRefusal("delete-provider", { providerId: PROVIDER }, U.owner)).toBeNull();
		// A provider that does not exist is left to the plugin's own 404.
		expect(
			await ssoActionRefusal("delete-provider", { providerId: `${PROVIDER}-none` }, U.suspended),
		).toBeNull();
	});

	it("does not resolve the console URL's org for a suspended member; an active member resolves", async () => {
		h.path = `/${SLUG}/settings`;
		await expect(urlScopedOrgId(U.suspended)).rejects.toThrow();
		await expect(urlScopedOrgId(U.owner)).resolves.toBe(ORG);
	});
});
