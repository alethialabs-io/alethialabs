// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the Members list walks ONE total alphabetical keyset order, a page at a time (#6298,
// LST-8 #7490).
//
// `queryMembersPage` reads member rows and pending invitations as one list, alphabetical by what each
// row displays (a member's name, or their email when the name is blank; an invitation's email),
// through the codec's text mode: `lower(display) COLLATE "C"`, then the id. Each kind is read with
// its own strictly-after-the-cursor predicate and the two are merged in memory. The unit test pins
// the ORDER BY text and the merge over fixtures; this case asks Postgres what they DO:
//
//   * case folding is the database's: "beth" sorts after "Ada" and before "Cy";
//   * a member with no name sorts by their email, and interleaves with invitations by email;
//   * two rows whose display folds to the same text are split by id, and a walk with a page smaller
//     than the list visits every row exactly once, in the order one big page gives — which is where
//     the in-memory merge and the SQL comparison must agree.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { invitation, member, organization, user } from "@/lib/db/schema";
import { decodeKeysetTextCursor } from "@/lib/queries/keyset";
import { queryMembersPage } from "@/lib/queries/members";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const TAG = ORG.slice(0, 8);

/** Seeded users; their member rows are listed by `name` (or the email when it is null). */
const USERS = [
	{ id: randomUUID(), name: "Ada", email: `zz-ada-${TAG}@example.test` },
	{ id: randomUUID(), name: "beth", email: `zz-beth-${TAG}@example.test` },
	{ id: randomUUID(), name: null, email: `bz-${TAG}@example.test` },
	{ id: randomUUID(), name: "Cy", email: `zz-cy1-${TAG}@example.test` },
	{ id: randomUUID(), name: "cy", email: `zz-cy2-${TAG}@example.test` },
];

/** Pending invitations, listed by email. */
const INVITES = [
	{ id: randomUUID(), email: `amy-${TAG}@example.test` },
	{ id: randomUUID(), email: `cz-${TAG}@example.test` },
];

/** The two "cy" members fold to one sort text, so their ids decide. */
const CY = [USERS[3], USERS[4]].map((u) => u.id);

describeIfDb("the members page walks one alphabetical keyset order (#6298, #7490)", () => {
	/** Member row id per user id, filled in by the seed. */
	const memberOf = new Map<string, string>();

	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values(USERS);
		await db.insert(organization).values({ id: ORG, name: `org-6298-${TAG}` });
		const rows = await db
			.insert(member)
			.values([...USERS].reverse().map((u) => ({ organizationId: ORG, userId: u.id, role: "admin" })))
			.returning({ id: member.id, userId: member.userId });
		for (const r of rows) memberOf.set(r.userId, r.id);
		await db.insert(invitation).values(
			INVITES.map((i) => ({
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

	/** The expected walk: ada, amy@…, beth, bz-…@ (no name), cy ×2 by member id, cz-…@. */
	function expected(): string[] {
		const m = (i: number) => memberOf.get(USERS[i].id) ?? "";
		const cys = CY.map((u) => memberOf.get(u) ?? "").sort();
		return [m(0), INVITES[0].id, m(1), m(2), ...cys, INVITES[1].id];
	}

	it("lists both kinds in one page, alphabetical, case folded, ties broken by id", async () => {
		const page = await queryMembersPage(ORG, USERS[0].id);
		expect(page.rows.map((r) => r.id)).toEqual(expected());
		expect(page.nextCursor).toBeNull();
	});

	it("walks every row exactly once with a page of two, across the folded tie", async () => {
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard += 1) {
			const position = cursor === null ? undefined : (decodeKeysetTextCursor(cursor) ?? undefined);
			const page = await queryMembersPage(ORG, USERS[0].id, {}, { limit: 2, cursor: position });
			seen.push(...page.rows.map((r) => r.id));
			// Facets come with the first page only.
			expect(page.facets === null).toBe(cursor !== null);
			cursor = page.nextCursor;
			if (cursor === null) break;
		}
		expect(seen).toEqual(expected());
	});

	it("reads one row by id — the deep link — and nothing else", async () => {
		const page = await queryMembersPage(ORG, USERS[0].id, { id: INVITES[1].id });
		expect(page.rows.map((r) => r.id)).toEqual([INVITES[1].id]);
		const other = await queryMembersPage(randomUUID(), USERS[0].id, { id: INVITES[1].id });
		expect(other.rows.some((r) => r.id === INVITES[1].id)).toBe(false);
	});
});
