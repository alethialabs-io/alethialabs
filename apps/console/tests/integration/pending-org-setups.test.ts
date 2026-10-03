// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: pending_org_setups (#5445) against real Postgres — the server's record of a paid
// create-a-team setup. The unit tests run lib/billing/pending-org-setup.ts over a queue that returns
// rows whatever the WHERE says, so a review could replace the user filter with anything and stay
// green. These pin the predicates themselves, in their failing direction:
//
//   1. Every read and write is the ACTOR's: user B's calls neither see nor change user A's record.
//   2. The org lookup does not depend on the owner member row, and is still the actor's alone: an
//      organization user B owns that carries a marker for A's subscription — forged unstamped, or
//      stamped for A — is never handed to A; an organization stamped for A with NO members (the
//      better-auth member insert failed) is repaired with A as owner and the owner grant.
//   3. RLS: through the app role a user reads and writes only their own records.
//
// The RLS half needs the distinct app role (the migration role is BYPASSRLS) and skips without one —
// see APP_ROLE_DISTINCT in ./db. The rest runs through the service role, as the server actions do.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedAuthz } from "@/lib/authz/seed";
import {
	findSetupOrg,
	markPendingOrgSetupDeclared,
	pendingOrgSetupFor,
	recordPendingOrgSetup,
	savePendingOrgSetupDetails,
	unfinishedPendingOrgSetups,
} from "@/lib/billing/pending-org-setup";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { grants, member, organization, pendingOrgSetups, user } from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText } from "./db";

const USER_A = randomUUID();
const USER_B = randomUUID();
const SUB_A = `sub_it_${randomUUID().slice(0, 8)}`;
const SUB_B = `sub_it_${randomUUID().slice(0, 8)}`;
const ORG_B_FORGED = randomUUID(); // B's org, marker for SUB_A with no server stamp
const ORG_B_STAMPED = randomUUID(); // B's org (B is a member), marker stamped for A
const ORG_A_ORPHAN = randomUUID(); // stamped for A, no members — the failed member insert
const ORGS = [ORG_B_FORGED, ORG_B_STAMPED, ORG_A_ORPHAN];

/** Organization metadata as the create hook stamps it. */
function stamped(sub: string, by: string): string {
	return JSON.stringify({ newOrgSubscriptionId: sub, newOrgCreatedBy: by });
}

describeIfDb("pending_org_setups — the actor's own record, RLS, and the org lookup", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // the built-in role rows the owner grant references
		await db.insert(user).values([
			{ id: USER_A, email: `it-pending-a-${USER_A}@example.test` },
			{ id: USER_B, email: `it-pending-b-${USER_B}@example.test` },
		]);
		await recordPendingOrgSetup({
			userId: USER_A,
			subscriptionId: SUB_A,
			customerId: "cus_a",
			name: "Acme",
			slug: "acme",
		});
		await recordPendingOrgSetup({
			userId: USER_B,
			subscriptionId: SUB_B,
			customerId: "cus_b",
			name: "Bravo",
			slug: "bravo",
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(pendingOrgSetups).where(inArray(pendingOrgSetups.user_id, [USER_A, USER_B]));
		await db.delete(grants).where(inArray(grants.org_id, ORGS));
		await db.delete(organization).where(inArray(organization.id, ORGS));
		await db.delete(user).where(inArray(user.id, [USER_A, USER_B]));
	});

	it("reads only the actor's own record: B cannot see A's, by id or in the unfinished list", async () => {
		expect(await pendingOrgSetupFor(USER_B, SUB_A)).toBeNull();
		expect((await pendingOrgSetupFor(USER_A, SUB_A))?.intended_slug).toBe("acme");
		const bList = (await unfinishedPendingOrgSetups(USER_B)).map((r) => r.subscription_id);
		expect(bList).toContain(SUB_B);
		expect(bList).not.toContain(SUB_A);
	});

	it("writes only the actor's own record: B's save changes nothing of A's", async () => {
		await savePendingOrgSetupDetails(USER_B, SUB_A, { slug: "hijacked", billing: null });
		expect((await pendingOrgSetupFor(USER_A, SUB_A))?.intended_slug).toBe("acme");
	});

	it("never hands A an organization B owns, whatever its metadata names", async () => {
		const db = getServiceDb();
		await db.insert(organization).values([
			{
				id: ORG_B_FORGED,
				name: "forged",
				slug: `it-forged-${ORG_B_FORGED.slice(0, 8)}`,
				metadata: JSON.stringify({ newOrgSubscriptionId: SUB_A }),
			},
			{
				id: ORG_B_STAMPED,
				name: "stamped",
				slug: `it-stamped-${ORG_B_STAMPED.slice(0, 8)}`,
				metadata: stamped(SUB_A, USER_A),
			},
		]);
		await db.insert(member).values({ organizationId: ORG_B_STAMPED, userId: USER_B, role: "owner" });

		const rowA = await pendingOrgSetupFor(USER_A, SUB_A);
		if (!rowA) throw new Error("fixture: A's record is missing");
		expect(await findSetupOrg(rowA, USER_A)).toBeNull();
		const after = await db
			.select({ userId: member.userId })
			.from(member)
			.where(inArray(member.organizationId, [ORG_B_FORGED, ORG_B_STAMPED]));
		expect(after.map((m) => m.userId)).toEqual([USER_B]);
		await db.delete(organization).where(inArray(organization.id, [ORG_B_FORGED, ORG_B_STAMPED]));
	});

	it("an organization stamped for A with NO members is found and repaired with A as owner — not made again", async () => {
		const db = getServiceDb();
		await db.insert(organization).values({
			id: ORG_A_ORPHAN,
			name: "Acme",
			slug: `it-orphan-${ORG_A_ORPHAN.slice(0, 8)}`,
			metadata: stamped(SUB_A, USER_A),
		});
		const rowA = await pendingOrgSetupFor(USER_A, SUB_A);
		if (!rowA) throw new Error("fixture: A's record is missing");

		const found = await findSetupOrg(rowA, USER_A);
		expect(found?.id).toBe(ORG_A_ORPHAN);
		const members = await db
			.select({ userId: member.userId, role: member.role })
			.from(member)
			.where(eq(member.organizationId, ORG_A_ORPHAN));
		expect(members).toEqual([{ userId: USER_A, role: "owner" }]);
		const ownerGrant = await db
			.select({ id: grants.id })
			.from(grants)
			.where(and(eq(grants.org_id, ORG_A_ORPHAN), eq(grants.principal_id, USER_A)));
		expect(ownerGrant).toHaveLength(1);
		expect((await pendingOrgSetupFor(USER_A, SUB_A))?.created_org_id).toBe(ORG_A_ORPHAN);

		// A second resume adds nothing.
		await findSetupOrg(rowA, USER_A);
		const again = await db
			.select({ userId: member.userId })
			.from(member)
			.where(eq(member.organizationId, ORG_A_ORPHAN));
		expect(again).toHaveLength(1);
	});

	it("closes the record only for its owner: B declaring A's org leaves it open, A declaring closes it and drops the billing", async () => {
		await savePendingOrgSetupDetails(USER_A, SUB_A, {
			slug: "acme",
			billing: {
				name: "Acme GmbH",
				line1: "Hauptstr. 1",
				city: "Berlin",
				postalCode: "10115",
				country: "DE",
				taxType: "eu_vat",
				taxValue: "DE123456789",
				useAsPrimary: true,
			},
		});
		await markPendingOrgSetupDeclared(USER_B, ORG_A_ORPHAN);
		expect((await pendingOrgSetupFor(USER_A, SUB_A))?.declared_at).toBeNull();

		await markPendingOrgSetupDeclared(USER_A, ORG_A_ORPHAN);
		const closed = await pendingOrgSetupFor(USER_A, SUB_A);
		expect(closed?.declared_at).toBeInstanceOf(Date);
		expect(closed?.billing).toBeNull();
		expect((await unfinishedPendingOrgSetups(USER_A)).map((r) => r.subscription_id)).not.toContain(SUB_A);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("RLS: through the app role a user reads only their own records", async () => {
		const seenByA = await withOwnerScope(USER_A, (tx) =>
			tx.select({ sub: pendingOrgSetups.subscription_id }).from(pendingOrgSetups),
		);
		expect(seenByA.map((r) => r.sub)).toContain(SUB_A);
		expect(seenByA.map((r) => r.sub)).not.toContain(SUB_B);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("RLS: the app role cannot write a record for another user, nor change one", async () => {
		const text = await refusalText(() =>
			withOwnerScope(USER_A, (tx) =>
				tx.insert(pendingOrgSetups).values({
					user_id: USER_B,
					subscription_id: `sub_it_${randomUUID().slice(0, 8)}`,
					customer_id: "cus_x",
					intended_name: "x",
					intended_slug: "x",
				}),
			),
		);
		expect(text).toMatch(/row-level security/i);

		const changed = await withOwnerScope(USER_A, (tx) =>
			tx
				.update(pendingOrgSetups)
				.set({ intended_slug: "hijacked" })
				.where(eq(pendingOrgSetups.subscription_id, SUB_B))
				.returning({ id: pendingOrgSetups.id }),
		);
		expect(changed).toHaveLength(0);
		expect((await pendingOrgSetupFor(USER_B, SUB_B))?.intended_slug).toBe("bravo");
	});
});
