// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#5479): `ensureCliOrgAccess`'s session arm, for a caller whose resolved scope is NOT
// the path org, against real Postgres and the real community PDP.
//
// The defect: that arm asked only whether a `member` row existed in the path org. The route's
// permission had been enforced in the caller's resolved scope, a different org on exactly this arm.
// Against the previous head the viewer and suspended-admin cases below come back `null` (admitted).
//
// What is real here: the `member` read (so the `status` filter is exercised by Postgres, not by a
// mock), the grant rows, and the PDP decision. What is stubbed: `getActiveScope`, because community
// resolves every org to the personal one. The stub answers with the org it is asked for, which is
// what the ee resolver answers for an org the caller has a member row in. The membership gate runs
// BEFORE resolution, so the stub cannot admit a non-member.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: vi.fn(async (userId: string, orgId?: string) => ({
		userId,
		orgId: orgId ?? userId,
	})),
}));

import { ensureMemberGrant } from "@/lib/authz/grants";
import { ensureCliOrgAccess } from "@/lib/authz/guard";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import { grants, member, organization, user } from "@/lib/db/schema";

const ORG = randomUUID();
const U = {
	viewer: randomUUID(), // active, viewer grant: may view members, may not manage them
	suspended: randomUUID(), // admin role, SUSPENDED, but an admin grant row still present
	admin: randomUUID(), // active admin: the control
	outsider: randomUUID(), // no member row at all
};
const ALL_USERS = Object.values(U);

/** The caller as `authorizeCli` hands them over with no header: their personal scope. */
function personal(userId: string) {
	return { userId, orgId: userId };
}

describeIfDb("#5479 — cross-org CLI org access authorizes the permission in the path org", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db
			.insert(user)
			.values(ALL_USERS.map((id) => ({ id, email: `it-5479-${id}@example.test` })));
		await db.insert(organization).values({ id: ORG, name: `it-5479-${ORG.slice(0, 8)}` });
		await db.insert(member).values([
			{ organizationId: ORG, userId: U.viewer, role: "viewer" },
			{ organizationId: ORG, userId: U.suspended, role: "admin", status: "suspended" },
			{ organizationId: ORG, userId: U.admin, role: "admin" },
		]);
		await ensureMemberGrant(ORG, U.viewer, "viewer");
		await ensureMemberGrant(ORG, U.admin, "admin");
		// `ensureMemberGrant` writes nothing for a suspended member, so the row is inserted directly:
		// the case is a grant that outlived the suspension, which only the status filter can refuse.
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: U.suspended,
			role_id: BUILTIN_ROLE_IDS.admin,
			resource_type: "org",
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, ALL_USERS));
	});

	it("refuses manage_members to an active member who lacks it in the path org", async () => {
		const denied = await ensureCliOrgAccess(personal(U.viewer), "session", ORG, "manage_members", {
			type: "member",
		});
		expect(denied?.status).toBe(403);
	});

	it("refuses a suspended member even when an admin grant row survives", async () => {
		const denied = await ensureCliOrgAccess(
			personal(U.suspended),
			"session",
			ORG,
			"manage_members",
			{ type: "member" },
		);
		expect(denied?.status).toBe(403);
	});

	it("refuses a caller with no member row", async () => {
		const denied = await ensureCliOrgAccess(personal(U.outsider), "session", ORG, "view", {
			type: "member",
		});
		expect(denied?.status).toBe(403);
	});

	it("admits an active admin to manage_members, and a viewer to view (the controls)", async () => {
		expect(
			await ensureCliOrgAccess(personal(U.admin), "session", ORG, "manage_members", {
				type: "member",
			}),
		).toBeNull();
		expect(
			await ensureCliOrgAccess(personal(U.viewer), "session", ORG, "view", { type: "member" }),
		).toBeNull();
	});
});
