// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the Members list comes back in ONE total order (#6298).
//
// `queryMembersPage` used to read member rows and pending invitations with no ORDER BY, so the
// order was whatever the plan produced — and the Settings › Members table pages that list 20 rows
// at a time on the client, members first, then invitations. A re-read could move a row to another
// page or off every page. The unit test pins the ORDER BY text; this case asks Postgres what that
// text DOES, including the two places a string-level assertion cannot see:
//
//   * the sort key is case-folded — "beth" sorts after "Ada" and before "Cy";
//   * a member with no name sorts by their email, and two identically named members are split by
//     email, so equal display keys still come back in one order on every read.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { invitation, member, organization, user } from "@/lib/db/schema";
import { queryMembersPage } from "@/lib/queries/members";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const TAG = ORG.slice(0, 8);

/** Seeded users, in the order the page must list them. */
const USERS = [
	{ id: randomUUID(), name: "Ada", email: `it-6298-zz-${TAG}@example.test` },
	{ id: randomUUID(), name: "beth", email: `it-6298-${TAG}@example.test` },
	// No name: displayed (and sorted) by the email — "bz…", after "beth" and before "cy" under any
	// collation (no punctuation decides it, which glibc and ICU would skip at the first level).
	{ id: randomUUID(), name: null, email: `bzit-6298-${TAG}@example.test` },
	// Same display name as the next row — the email breaks the tie.
	{ id: randomUUID(), name: "Cy", email: `it-6298-a-${TAG}@example.test` },
	{ id: randomUUID(), name: "Cy", email: `it-6298-b-${TAG}@example.test` },
];

/** Pending invitations, in the order the page must list them. */
const INVITES = [
	{ id: randomUUID(), email: `amy-${TAG}@example.test`, createdAt: new Date("2026-03-01T00:00:00Z") },
	// The same address invited twice: the older invitation first.
	{ id: randomUUID(), email: `Bob-${TAG}@example.test`, createdAt: new Date("2026-01-01T00:00:00Z") },
	{ id: randomUUID(), email: `bob-${TAG}@example.test`, createdAt: new Date("2026-02-01T00:00:00Z") },
	{ id: randomUUID(), email: `zoe-${TAG}@example.test`, createdAt: new Date("2025-12-01T00:00:00Z") },
];

describeIfDb("the members page lists rows in one total order (#6298)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values(USERS);
		await db.insert(organization).values({ id: ORG, name: `org-6298-${TAG}` });
		// Inserted in REVERSE so the heap order is the opposite of the wanted order: a read with no
		// ORDER BY would most likely hand them back reversed and fail the assertion below.
		await db.insert(member).values(
			[...USERS].reverse().map((u) => ({ organizationId: ORG, userId: u.id, role: "admin" })),
		);
		await db.insert(invitation).values(
			[...INVITES].reverse().map((i) => ({
				...i,
				organizationId: ORG,
				role: "viewer",
				status: "pending",
				expiresAt: new Date("2099-01-01T00:00:00Z"),
				inviterId: USERS[0].id,
			})),
		);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(invitation).where(eq(invitation.organizationId, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, USERS.map((u) => u.id)));
	});

	it("orders members by displayed name case-folded, then email", async () => {
		const page = await queryMembersPage(ORG, USERS[0].id);
		expect(page.members.map((m) => m.userId)).toEqual(USERS.map((u) => u.id));
	});

	it("orders pending invitations by email case-folded, then oldest first", async () => {
		const page = await queryMembersPage(ORG, USERS[0].id);
		expect(page.invitations.map((i) => i.id)).toEqual(INVITES.map((i) => i.id));
	});

	it("keeps that order on a filtered read", async () => {
		const page = await queryMembersPage(ORG, USERS[0].id, { search: "it-6298" });
		// The search matches every member's email; the order is the unfiltered one, narrowed.
		expect(page.members.map((m) => m.userId)).toEqual(USERS.map((u) => u.id));
	});
});
