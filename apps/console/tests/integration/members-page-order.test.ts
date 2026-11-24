// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the Members list walks ONE total keyset order, a page at a time (#6298, LST-8 #7490).
//
// `queryMembersPage` reads member rows and pending invitations as one list: newest first by when
// the row came to be (a member's join, an invitation's send) truncated to the millisecond, then the
// id. Each kind is read with its own strictly-after-the-cursor predicate and the two are merged. The
// unit test pins the ORDER BY text and the merge over fixtures; this case asks Postgres what they DO,
// including the two places a fixture cannot reach:
//
//   * rows that share a millisecond — two of them some microseconds into it — across the two
//     tables, which only the ms-truncated sort key and the id tiebreak keep on one side of a page
//     boundary;
//   * a walk with a page smaller than the list visits every row exactly once, in the order one big
//     page would have given.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { invitation, member, organization, user } from "@/lib/db/schema";
import { decodeKeysetCursor } from "@/lib/queries/keyset";
import { queryMembersPage } from "@/lib/queries/members";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const TAG = ORG.slice(0, 8);

const USERS = Array.from({ length: 3 }, (_, i) => ({
	id: randomUUID(),
	name: `it-6298 user ${i}`,
	email: `it-6298-${i}-${TAG}@example.test`,
}));

/** One shared millisecond; a suffix of three more digits puts a row microseconds into it. */
const TIE = "2026-03-01T00:00:00.000";

const MEMBERS = [
	{ id: randomUUID(), userId: USERS[0].id, at: `${TIE}123Z` },
	{ id: randomUUID(), userId: USERS[1].id, at: `${TIE}000Z` },
	{ id: randomUUID(), userId: USERS[2].id, at: "2026-04-01T00:00:00.000Z" },
];
const INVITES = [
	{ id: randomUUID(), email: `amy-${TAG}@example.test`, at: `${TIE}456Z` },
	{ id: randomUUID(), email: `bob-${TAG}@example.test`, at: `${TIE}000Z` },
	{ id: randomUUID(), email: `cy-${TAG}@example.test`, at: "2026-02-01T00:00:00.000Z" },
];

/**
 * The order the list must walk: the April member, then the four rows of the tied millisecond by id
 * descending (uuid order is lexicographic over lower-case hex), then the February invitation.
 */
const EXPECTED = [
	MEMBERS[2].id,
	...[MEMBERS[0], MEMBERS[1], INVITES[0], INVITES[1]].map((r) => r.id).sort().reverse(),
	INVITES[2].id,
];

describeIfDb("the members page walks one keyset order (#6298, #7490)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values(USERS);
		await db.insert(organization).values({ id: ORG, name: `org-6298-${TAG}` });
		for (const m of MEMBERS) {
			await db.insert(member).values({ id: m.id, organizationId: ORG, userId: m.userId, role: "admin" });
			// Microsecond precision is the point, and a JS Date cannot carry it — set in SQL.
			await db.execute(sql`update ${member} set created_at = ${m.at}::timestamptz where id = ${m.id}`);
		}
		for (const i of INVITES) {
			await db.insert(invitation).values({
				id: i.id,
				email: i.email,
				organizationId: ORG,
				role: "viewer",
				status: "pending",
				expiresAt: new Date("2099-01-01T00:00:00Z"),
				inviterId: USERS[0].id,
			});
			await db.execute(sql`update ${invitation} set created_at = ${i.at}::timestamptz where id = ${i.id}`);
		}
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(invitation).where(eq(invitation.organizationId, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, USERS.map((u) => u.id)));
	});

	it("lists both kinds in one page, newest first, ties broken by id", async () => {
		const page = await queryMembersPage(ORG, USERS[0].id);
		expect(page.rows.map((r) => r.id)).toEqual(EXPECTED);
		expect(page.nextCursor).toBeNull();
	});

	it("walks every row exactly once with a page of two, across the tied millisecond", async () => {
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard += 1) {
			const position = cursor === null ? undefined : (decodeKeysetCursor(cursor) ?? undefined);
			const page = await queryMembersPage(ORG, USERS[0].id, {}, { limit: 2, cursor: position });
			seen.push(...page.rows.map((r) => r.id));
			// Facets come with the first page only.
			expect(page.facets === null).toBe(cursor !== null);
			cursor = page.nextCursor;
			if (cursor === null) break;
		}
		expect(seen).toEqual(EXPECTED);
	});

	it("keeps that order on a filtered read", async () => {
		const page = await queryMembersPage(ORG, USERS[0].id, { statuses: ["pending"] });
		const invites = new Set(INVITES.map((i) => i.id));
		expect(page.rows.map((r) => r.id)).toEqual(EXPECTED.filter((id) => invites.has(id)));
	});
});
