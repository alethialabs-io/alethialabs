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
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Stripe is the one boundary faked here (#5714's cases): the guard and the closer read the
// subscription from it, and nothing in this file may reach the network. Every other module is real.
const fakeStripe = vi.hoisted(() => ({
	subscriptions: { retrieve: vi.fn(), create: vi.fn(), list: vi.fn() },
	customers: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
	checkout: { sessions: { create: vi.fn() } },
	invoicePayments: { list: vi.fn() },
}));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => fakeStripe }));

import { createSubscriptionIntent } from "@/app/server/actions/billing";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import type { Actor, Entitlements } from "@/lib/authz/types";
import { seedAuthz } from "@/lib/authz/seed";
import {
	NEW_ORG_SETUP_IN_PROGRESS_CODE,
	NEW_ORG_SUBSCRIPTION_KEY,
} from "@/lib/billing/new-org-setup";
import {
	closePendingOrgSetup,
	findSetupOrg,
	forgetPendingOrgSetup,
	liveCheckSetupCustomers,
	openPaymentHoldOn,
	paymentHoldsOfPayer,
	markPendingOrgSetupDeclared,
	markPendingOrgSetupLinked,
	openPendingOrgSetupsForOrg,
	pendingOrgSetupFor,
	settleOpenSetup,
	recordPendingOrgSetup,
	savePendingOrgSetupDetails,
	stampNewOrgMetadata,
	type UnfinishedSetupCursor,
	unfinishedPendingOrgSetups,
	unlinkedPendingOrgSetupCustomers,
} from "@/lib/billing/pending-org-setup";
import { getServiceDb, withOwnerScope, withScope } from "@/lib/db";
import { pgErrorCode } from "@/lib/db/pg-error";
import {
	authzActivityLog,
	grants,
	member,
	organization,
	organizationBilling,
	paymentHolds,
	pendingOrgSetups,
	user,
} from "@/lib/db/schema";
import { closeSetup } from "@/scripts/pending-org-setups";
import { APP_ROLE_DISTINCT, describeIfDb, purgeAuthzActivityLog, refusalText } from "./db";

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
		const bList = (await unfinishedPendingOrgSetups(USER_B)).rows.map((r) => r.subscription_id);
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
		expect((await unfinishedPendingOrgSetups(USER_A)).rows.map((r) => r.subscription_id)).not.toContain(SUB_A);
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

// The concurrency half (#5445 review of 3aae22463). Each case is built to be DETERMINISTIC rather than
// to hope two promises interleave: the race is held open by a transaction that has not committed.
const RACER = randomUUID();
const OTHER = randomUUID();
const SUB_CLAIM = `sub_it_${randomUUID().slice(0, 8)}`;
const SUB_REPAIR = `sub_it_${randomUUID().slice(0, 8)}`;
const SUB_LEGACY = `sub_it_${randomUUID().slice(0, 8)}`;
const ORG_REPAIR = randomUUID();
const ORG_LEGACY = randomUUID();

describeIfDb("pending_org_setups — concurrent creates, the owner repair, and closing a legacy record", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values([
			{ id: RACER, email: `it-pending-racer-${RACER}@example.test` },
			{ id: OTHER, email: `it-pending-other-${OTHER}@example.test` },
		]);
		for (const sub of [SUB_CLAIM, SUB_REPAIR, SUB_LEGACY]) {
			await recordPendingOrgSetup({
				userId: RACER,
				subscriptionId: sub,
				customerId: "cus_racer",
				name: "Racer",
				slug: "racer",
			});
		}
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(pendingOrgSetups).where(inArray(pendingOrgSetups.user_id, [RACER, OTHER]));
		await db.delete(grants).where(inArray(grants.org_id, [ORG_REPAIR, ORG_LEGACY]));
		await db.delete(organization).where(inArray(organization.id, [ORG_REPAIR, ORG_LEGACY]));
		await db.delete(user).where(inArray(user.id, [RACER, OTHER]));
	});

	// Two creates for one charge (two tabs, different slugs). Against 3aae22463 both read "no org yet"
	// and both were stamped, so two organizations were made for one payment.
	it("two creates for one charge in the same instant: exactly one is let through, the other is told it is in progress", async () => {
		const marker = { [NEW_ORG_SUBSCRIPTION_KEY]: SUB_CLAIM };
		const verdicts = await Promise.all([
			stampNewOrgMetadata(marker, RACER),
			stampNewOrgMetadata(marker, RACER),
		]);
		const through = verdicts.filter((v) => v !== null && "metadata" in v);
		const refused = verdicts.filter((v) => v !== null && "refusal" in v);
		expect(through).toHaveLength(1);
		expect(refused).toEqual([
			{ refusal: { code: NEW_ORG_SETUP_IN_PROGRESS_CODE, message: expect.any(String) } },
		]);
		expect((await pendingOrgSetupFor(RACER, SUB_CLAIM))?.creating_at).toBeInstanceOf(Date);
	});

	// better-auth inserts the org, then (separately) the creator's member row. The repair can run in
	// that gap. Held open here by a transaction that has inserted the creator's row and not committed:
	// the repair reads "no members", inserts, and — with the unique index — waits for the transaction,
	// then does nothing. Against 3aae22463 there was no index, so both rows landed: two owner rows, two
	// billable seats.
	it("the owner repair racing better-auth's own creator insert leaves ONE member row", async () => {
		const db = getServiceDb();
		await db.insert(organization).values({
			id: ORG_REPAIR,
			name: "Racer",
			slug: `it-repair-${ORG_REPAIR.slice(0, 8)}`,
			metadata: JSON.stringify({ newOrgSubscriptionId: SUB_REPAIR, newOrgCreatedBy: RACER }),
		});
		const row = await pendingOrgSetupFor(RACER, SUB_REPAIR);
		if (!row) throw new Error("fixture: the racer's record is missing");

		let repair: Promise<unknown> = Promise.resolve();
		await db.transaction(async (tx) => {
			await tx.insert(member).values({ organizationId: ORG_REPAIR, userId: RACER, role: "owner" });
			repair = findSetupOrg(row, RACER);
			// Long enough for the repair to read "no members" and reach its insert.
			await new Promise((r) => setTimeout(r, 1500));
		});
		await expect(repair).resolves.toEqual({ id: ORG_REPAIR, slug: `it-repair-${ORG_REPAIR.slice(0, 8)}` });
		const rows = await db
			.select({ userId: member.userId })
			.from(member)
			.where(eq(member.organizationId, ORG_REPAIR));
		expect(rows).toHaveLength(1);
	});

	it("one membership per (organization, user): a second row for the same pair is refused by the database", async () => {
		const text = await refusalText(() =>
			getServiceDb().insert(member).values({ organizationId: ORG_REPAIR, userId: RACER, role: "admin" }),
		);
		expect(text).toMatch(/member_organization_user_unique|duplicate key/i);
	});

	// A record backfilled for a subscription minted before the table existed has no created_org_id.
	// Against 3aae22463 the declaration matched on created_org_id alone, so it stayed open for good.
	it("a declaration closes a record with no created_org_id by the subscription the org is linked to — and only the owner's", async () => {
		const db = getServiceDb();
		await db.insert(organization).values({
			id: ORG_LEGACY,
			name: "Legacy",
			slug: `it-legacy-${ORG_LEGACY.slice(0, 8)}`,
		});
		await db.insert(organizationBilling).values({
			organizationId: ORG_LEGACY,
			stripeSubscriptionId: SUB_LEGACY,
		});
		expect((await pendingOrgSetupFor(RACER, SUB_LEGACY))?.created_org_id).toBeNull();

		await markPendingOrgSetupDeclared(OTHER, ORG_LEGACY);
		expect((await pendingOrgSetupFor(RACER, SUB_LEGACY))?.declared_at).toBeNull();

		await markPendingOrgSetupDeclared(RACER, ORG_LEGACY);
		const closed = await pendingOrgSetupFor(RACER, SUB_LEGACY);
		expect(closed?.declared_at).toBeInstanceOf(Date);
		expect(closed?.created_org_id).toBe(ORG_LEGACY);
		// The other records of the same user are not touched.
		expect((await pendingOrgSetupFor(RACER, SUB_CLAIM))?.declared_at).toBeNull();
	});
});

// #5463: `findUnfinishedNewOrgSetup` deletes expired records from the page it is reading. With OFFSET
// pages each delete shifted the later rows back into the part already read, so they were skipped. The
// keyset page starts after the last row's (created_at, id), whatever was deleted. The timestamps sit in
// one millisecond and a tie, so a cursor rounded to a JS Date, or ordered without the id, would skip.
describeIfDb("pending_org_setups — keyset pages while records are deleted", () => {
	const PAGER = randomUUID();
	const subs = Array.from({ length: 7 }, (_, i) => `sub_page_${i}_${randomUUID().slice(0, 6)}`);
	const AT = [
		"2026-10-03 12:00:00.123900+00",
		"2026-10-03 12:00:00.123800+00",
		"2026-10-03 12:00:00.123700+00",
		"2026-10-03 12:00:00.123700+00",
		"2026-10-03 12:00:00.123600+00",
		"2026-10-03 12:00:00.123500+00",
		"2026-10-03 12:00:00.123400+00",
	];

	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values({ id: PAGER, email: `it-pager-${PAGER}@example.test` });
		for (const [i, sub] of subs.entries()) {
			await recordPendingOrgSetup({
				userId: PAGER,
				subscriptionId: sub,
				customerId: i < 4 ? "cus_page_new" : "cus_page_old",
				name: "Pager",
				slug: "pager",
			});
			await db.execute(
				sql`update pending_org_setups set created_at = ${AT[i]}::timestamptz where subscription_id = ${sub}`,
			);
		}
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(pendingOrgSetups).where(eq(pendingOrgSetups.user_id, PAGER));
		await db.delete(user).where(eq(user.id, PAGER));
	});

	it("reads every record once, newest first, while the first row of each page is deleted", async () => {
		const read: string[] = [];
		let after: UnfinishedSetupCursor | undefined;
		for (let guard = 0; guard < 20; guard += 1) {
			const page = await unfinishedPendingOrgSetups(PAGER, 2, after);
			read.push(...page.rows.map((r) => r.subscription_id));
			const first = page.rows[0];
			if (first) {
				await getServiceDb()
					.delete(pendingOrgSetups)
					.where(eq(pendingOrgSetups.subscription_id, first.subscription_id));
			}
			if (!page.next) break;
			after = page.next;
		}
		expect(read).toHaveLength(subs.length);
		expect(new Set(read)).toEqual(new Set(subs));
		expect(read.slice(0, 2)).toEqual([subs[0], subs[1]]);
	});

	it("lists each unlinked customer once, newest record first, and leaves out one whose setup is linked", async () => {
		await recordPendingOrgSetup({
			userId: PAGER,
			subscriptionId: `sub_page_linked_${randomUUID().slice(0, 6)}`,
			customerId: "cus_page_linked",
			name: "Pager",
			slug: "pager",
		});
		await getServiceDb()
			.update(pendingOrgSetups)
			.set({ linked_at: new Date() })
			.where(and(eq(pendingOrgSetups.user_id, PAGER), eq(pendingOrgSetups.customer_id, "cus_page_linked")));
		await recordPendingOrgSetup({
			userId: PAGER,
			subscriptionId: `sub_page_again_${randomUUID().slice(0, 6)}`,
			customerId: "cus_page_old",
			name: "Pager",
			slug: "pager",
		});
		// The first test left records of both customers; cus_page_old now has the newest one.
		expect(await unlinkedPendingOrgSetupCustomers(PAGER)).toEqual({ kind: "all", customers: ["cus_page_old", "cus_page_new"] });
	});
});

// ── ADR 0002 S3 (#5754), C21: `unlinkedPendingOrgSetupCustomers` reads every record, or refuses ──────
//
// It used to answer the newest 5 customers and drop the rest, so the create-a-team sweep never read a
// payment still settling on the 6th. It now pages over EVERY unlinked record by keyset (100 a page) and
// answers `over_cap` — with no list — beyond 50 distinct customers. Each user below owns only its own
// records, so the files running beside this one cannot change what it reads.
describeIfDb("pending_org_setups — C21: every unlinked customer, or over_cap", () => {
	const users: string[] = [];

	/** A user with one unlinked record per entry of `customers`, the first entry the NEWEST record. */
	async function userWithRecords(customers: readonly string[], at: (i: number) => string): Promise<string> {
		const id = randomUUID();
		users.push(id);
		const db = getServiceDb();
		await db.insert(user).values({ id, email: `it-c21-${id}@example.test` });
		await db.insert(pendingOrgSetups).values(
			customers.map((customer, i) => ({
				user_id: id,
				subscription_id: `sub_c21_${randomUUID()}`,
				customer_id: customer,
				intended_name: "C21",
				intended_slug: "c21",
				created_at: new Date(at(i)),
			})),
		);
		return id;
	}

	/** One second earlier per index: index 0 is the newest record. */
	const secondsBefore = (i: number) => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) - i * 1000).toISOString();

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(pendingOrgSetups).where(inArray(pendingOrgSetups.user_id, users));
		await db.delete(user).where(inArray(user.id, users));
	});

	it("returns all 7 customers of 7 unlinked records, newest first — not the newest 5", async () => {
		const customers = Array.from({ length: 7 }, (_, i) => `cus_c21_seven_${i}`);
		const id = await userWithRecords(customers, secondsBefore);
		expect(await unlinkedPendingOrgSetupCustomers(id)).toEqual({ kind: "all", customers });
	});

	it("pages past the first 100 records: a customer named only by the oldest record, past a tie, is still returned", async () => {
		// 1 newest record on cus_head, 249 on cus_bulk all in ONE microsecond (so pages break inside a
		// tie, which only the id orders), and the oldest on cus_tail — the 251st record, on page 3.
		const customers = ["cus_c21_head", ...Array.from({ length: 249 }, () => "cus_c21_bulk"), "cus_c21_tail"];
		const id = await userWithRecords(customers, (i) =>
			i === 0 ? "2026-10-09T12:00:01.000Z" : i === customers.length - 1 ? "2026-10-09T11:59:59.000Z" : "2026-10-09T12:00:00.000Z",
		);
		expect(await unlinkedPendingOrgSetupCustomers(id)).toEqual({
			kind: "all",
			customers: ["cus_c21_head", "cus_c21_bulk", "cus_c21_tail"],
		});
	});

	it("exactly 50 customers are all returned; a 51st answers over_cap, with no list", async () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `cus_c21_fifty_${i}`);
		const atCap = await userWithRecords(fifty, secondsBefore);
		const all = await unlinkedPendingOrgSetupCustomers(atCap);
		expect(all.kind === "all" ? all.customers : []).toHaveLength(50);

		const overCap = await userWithRecords([...fifty, "cus_c21_fifty_first"], secondsBefore);
		expect(await unlinkedPendingOrgSetupCustomers(overCap)).toEqual({ kind: "over_cap" });
	});

	it("leaves out records that are linked, declared, or have an org — they do not count toward the cap", async () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `cus_c21_live_${i}`);
		const id = await userWithRecords([...fifty, "cus_c21_done"], secondsBefore);
		await getServiceDb()
			.update(pendingOrgSetups)
			.set({ linked_at: new Date() })
			.where(and(eq(pendingOrgSetups.user_id, id), eq(pendingOrgSetups.customer_id, "cus_c21_done")));
		expect(await unlinkedPendingOrgSetupCustomers(id)).toEqual({ kind: "all", customers: fifty });
	});
});

// ── ADR 0002 S1 (#5714): the open-setup guard against real Postgres, RLS and the PDP ────────────────
//
// The guard reads the creator's row with the SERVICE role, because the buyer may be a co-owner whom
// RLS shows nothing of it (C81's co-owner half). It finds the row by `created_org_id` or by the org's
// own server-stamped marker (C93). And the closer's writes are compare-and-sets whose predicate only
// SQL can pin: `closed_at IS NULL AND linked_at IS NULL` (C85, C87). None of these functions exists
// on dev, so each case fails there at the import.
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

describeIfDb("pending_org_setups — the open-setup guard, its closer and their predicates (#5714)", () => {
	const CREATOR = randomUUID();
	const CO_OWNER = randomUUID();
	const ORG = randomUUID(); // created for SUB_OPEN; the link never ran
	const ORG_MARKED = randomUUID(); // carries SUB_MARKED's marker; created_org_id never written (C93)
	const ORG_RACE = randomUUID();
	const SUB_OPEN = `sub_it_open_${randomUUID().slice(0, 8)}`;
	const SUB_MARKED = `sub_it_mark_${randomUUID().slice(0, 8)}`;
	const SUB_RACE = `sub_it_race_${randomUUID().slice(0, 8)}`;
	const SUB_ADOPT = `sub_it_adpt_${randomUUID().slice(0, 8)}`;
	const ORGS = [ORG, ORG_MARKED, ORG_RACE];
	let savedStripeKey: string | undefined;

	/** An owner-member actor in `orgId`, as the PDP sees one. */
	const actorIn = (userId: string, orgId: string): Actor => ({ credential: "session", userId, orgId, entitlements: ENTITLEMENTS });

	beforeAll(async () => {
		savedStripeKey = process.env.STRIPE_SECRET_KEY;
		process.env.STRIPE_SECRET_KEY = "sk_test_integration_never_used";
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values([
			{ id: CREATOR, name: "Ada Creator", email: `it-guard-creator-${CREATOR}@example.test` },
			{ id: CO_OWNER, name: "Bo Owner", email: `it-guard-coowner-${CO_OWNER}@example.test` },
		]);
		await db.insert(organization).values([
			{ id: ORG, name: "Guarded", slug: `it-guard-${ORG.slice(0, 8)}` },
			{
				id: ORG_MARKED,
				name: "Marked",
				slug: `it-marked-${ORG_MARKED.slice(0, 8)}`,
				metadata: stamped(SUB_MARKED, CREATOR),
			},
			{ id: ORG_RACE, name: "Race", slug: `it-race-${ORG_RACE.slice(0, 8)}` },
		]);
		for (const [orgId, userId] of [
			[ORG, CREATOR],
			[ORG, CO_OWNER],
			[ORG_MARKED, CREATOR],
		] as const) {
			await db.insert(member).values({ organizationId: orgId, userId, role: "owner" });
			await db.insert(grants).values({
				org_id: orgId,
				principal_type: "user",
				principal_id: userId,
				effect: "allow",
				role_id: BUILTIN_ROLE_IDS.owner,
				resource_type: "org",
				resource_id: null,
			});
		}
		for (const sub of [SUB_OPEN, SUB_MARKED, SUB_RACE, SUB_ADOPT]) {
			await recordPendingOrgSetup({
				userId: CREATOR,
				subscriptionId: sub,
				customerId: "cus_it_guard",
				name: "Guarded Team",
				slug: "guarded-team",
			});
		}
		await db
			.update(pendingOrgSetups)
			.set({ created_org_id: ORG })
			.where(inArray(pendingOrgSetups.subscription_id, [SUB_OPEN, SUB_ADOPT]));
		await db.update(pendingOrgSetups).set({ created_org_id: ORG_RACE }).where(eq(pendingOrgSetups.subscription_id, SUB_RACE));
		// X is live and was never linked in Stripe: no reader can close or adopt it.
		fakeStripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
			id,
			status: "active",
			customer: "cus_it_guard",
			latest_invoice: null,
			currency: "eur",
			items: { data: [] },
			metadata: { created_by: CREATOR },
		}));
	});

	afterAll(async () => {
		if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
		else process.env.STRIPE_SECRET_KEY = savedStripeKey;
		const db = getServiceDb();
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, ORGS));
		await db.delete(pendingOrgSetups).where(eq(pendingOrgSetups.user_id, CREATOR));
		await db.delete(organizationBilling).where(inArray(organizationBilling.organizationId, ORGS));
		await db.delete(grants).where(inArray(grants.org_id, ORGS));
		await db.delete(organization).where(inArray(organization.id, ORGS));
		await db.delete(user).where(inArray(user.id, [CREATOR, CO_OWNER]));
	});

	it.skipIf(!APP_ROLE_DISTINCT)("C81: the co-owner's own session cannot read the creator's row under RLS", async () => {
		const seen = await withScope({ ownerId: CO_OWNER, orgId: ORG }, (tx) =>
			tx
				.select({ sub: pendingOrgSetups.subscription_id })
				.from(pendingOrgSetups)
				.where(eq(pendingOrgSetups.subscription_id, SUB_OPEN)),
		);
		expect(seen).toEqual([]);
	});

	it("C81: a co-owner's plan purchase is refused all the same, naming only the creator — no other column of the row", async () => {
		fakeStripe.subscriptions.create.mockClear();
		const r = await runWithActor(actorIn(CO_OWNER, ORG), () => createSubscriptionIntent("team"));
		expect(r).toEqual({
			error:
				"Ada Creator started paying for this team's plan and it is still being set up, so a plan cannot be started here yet. Ask them, or contact support at support@alethialabs.io.",
		});
		const message = "error" in r ? r.error : "";
		for (const column of [SUB_OPEN, "cus_it_guard", "Guarded Team", "guarded-team", CREATOR]) {
			expect(message).not.toContain(column);
		}
		expect(fakeStripe.subscriptions.create).not.toHaveBeenCalled();
		expect(fakeStripe.customers.create).not.toHaveBeenCalled();
	});

	it("C93: the org's marker alone names the setup — refused although created_org_id was never written", async () => {
		expect((await pendingOrgSetupFor(CREATOR, SUB_MARKED))?.created_org_id).toBeNull();
		expect((await openPendingOrgSetupsForOrg(ORG_MARKED)).map((r) => r.subscription_id)).toEqual([SUB_MARKED]);
		const r = await runWithActor(actorIn(CREATOR, ORG_MARKED), () => createSubscriptionIntent("team"));
		expect(r).toEqual({ error: expect.stringMatching(/^Your paid setup for this team has not finished/) });
		expect(fakeStripe.subscriptions.create).not.toHaveBeenCalled();
	});

	it("C85: the partial index exists, and the guard's read by created_org_id uses it", async () => {
		const db = getServiceDb();
		const idx = await db.execute(
			sql`select indexdef from pg_indexes where tablename = 'pending_org_setups' and indexname = 'pending_org_setups_open_org_idx'`,
		);
		expect(String(idx[0]?.indexdef)).toMatch(/\(created_org_id\) WHERE \(\(linked_at IS NULL\) AND \(closed_at IS NULL\)\)/);
		const plan = await db.transaction(async (tx) => {
			await tx.execute(sql`set local enable_seqscan = off`);
			return tx.execute(
				sql`explain select * from pending_org_setups where linked_at is null and closed_at is null and created_org_id = ${ORG}::uuid`,
			);
		});
		expect(plan.map((row) => String(Object.values(row)[0])).join("\n")).toMatch(/pending_org_setups_open_org_idx/);
	});

	it("C87: two closers at once — exactly one compare-and-set returns the row; a closed setup no longer blocks, is not unfinished, and is never marked linked", async () => {
		const results = await Promise.all([
			closePendingOrgSetup({ subscriptionId: SUB_RACE, reason: "ended" }),
			closePendingOrgSetup({ subscriptionId: SUB_RACE, reason: "ended" }),
		]);
		expect(results.filter((r) => r !== null)).toHaveLength(1);
		expect(await closePendingOrgSetup({ subscriptionId: SUB_RACE, reason: "ended" })).toBeNull();
		const closed = await pendingOrgSetupFor(CREATOR, SUB_RACE);
		expect(closed?.closed_at).toBeInstanceOf(Date);
		expect(closed?.closed_reason).toBe("ended");

		expect(await openPendingOrgSetupsForOrg(ORG_RACE)).toEqual([]);
		const unfinished = (await unfinishedPendingOrgSetups(CREATOR, 50)).rows.map((r) => r.subscription_id);
		expect(unfinished).not.toContain(SUB_RACE);
		expect(unfinished).toContain(SUB_OPEN);

		await markPendingOrgSetupLinked(CREATOR, SUB_RACE, ORG_RACE);
		expect((await pendingOrgSetupFor(CREATOR, SUB_RACE))?.linked_at).toBeNull();
	});

	it("C96: the closer adopts an X the org's row already names — linked_at set once — and the guard then lets the org buy", async () => {
		const db = getServiceDb();
		await db.insert(organizationBilling).values({ organizationId: ORG, stripeSubscriptionId: SUB_ADOPT, status: "active" });
		const linkedX = {
			id: SUB_ADOPT,
			status: "active",
			customer: "cus_it_guard",
			latest_invoice: null,
			currency: "eur",
			items: { data: [] },
			metadata: { created_by: CREATOR, organization_id: ORG },
		};
		const row = await pendingOrgSetupFor(CREATOR, SUB_ADOPT);
		if (!row) throw new Error("fixture: the adopt record is missing");
		await expect(settleOpenSetup(row, { sub: linkedX as never, orgId: ORG })).resolves.toBe("linked");
		const first = (await pendingOrgSetupFor(CREATOR, SUB_ADOPT))?.linked_at;
		expect(first).toBeInstanceOf(Date);
		await expect(settleOpenSetup(row, { sub: linkedX as never, orgId: ORG })).resolves.toBe("linked");
		expect((await pendingOrgSetupFor(CREATOR, SUB_ADOPT))?.linked_at).toEqual(first);
		expect((await openPendingOrgSetupsForOrg(ORG)).map((r) => r.subscription_id)).toEqual([SUB_OPEN]);
	});

	it("C81: once the last open setup is closed, the org's guard reads nothing", async () => {
		await closePendingOrgSetup({ subscriptionId: SUB_OPEN, reason: "operator", closedBy: CO_OWNER, note: "it" });
		expect(await openPendingOrgSetupsForOrg(ORG)).toEqual([]);
	});
});

// ADR 0002 S8 (#5926). I16 (a), C92: a setup whose subscription has an OPEN payment hold is never closed —
// not by the closer, not by the link's compare-and-set, not by the operator's `close-setup` — and the
// hold's release decides it. §8: `forgetPendingOrgSetup` keeps a record a hold names unless the hold was
// released as never payable. C94: the live check's record set includes records whose team exists, and
// closed ones. Each fails on dev, where none of these predicates reads `payment_holds`.
describeIfDb("pending_org_setups — S8: payment holds decide the setup (I16, C92), and the live check's records (C94)", () => {
	const U = randomUUID();
	const OTHER = randomUUID();
	const ORG_H = randomUUID();
	const sub = (tag: string) => `sub_it_s8_${tag}_${randomUUID().slice(0, 8)}`;
	const SUB_HELD = sub("held");
	const SUB_F_OPEN = sub("fopen");
	const SUB_F_REFUNDED = sub("fref");
	const SUB_F_VOIDED = sub("fvoid");
	const SUB_F_NONE = sub("fnone");
	const SUB_OTHER = sub("other");
	const ALL = [SUB_HELD, SUB_F_OPEN, SUB_F_REFUNDED, SUB_F_VOIDED, SUB_F_NONE, SUB_OTHER];
	let savedStripeKey: string | undefined;

	/** Inserts a hold of `payer` on `subscriptionId`, open (`closing`) unless `released` names a reason. */
	async function hold(subscriptionId: string, payer: string, released?: "voided_unpaid" | "refunded"): Promise<void> {
		await getServiceDb()
			.insert(paymentHolds)
			.values({
				subscription_id: subscriptionId,
				customer_id: "cus_it_s8",
				payer_key: payer,
				invoice_id: `in_${subscriptionId}`,
				state: released ? "released" : "closing",
				release_reason: released ?? null,
				released_at: released ? new Date() : null,
				next_check_at: released ? null : new Date(),
				opened_by: "purchase",
			});
	}

	/** X as Stripe reads it: canceled, never linked. */
	const canceledX = (id: string) => ({
		id,
		status: "canceled",
		customer: "cus_it_s8",
		latest_invoice: null,
		currency: "eur",
		items: { data: [] },
		metadata: { created_by: U },
	});

	beforeAll(async () => {
		savedStripeKey = process.env.STRIPE_SECRET_KEY;
		process.env.STRIPE_SECRET_KEY = "sk_test_integration_never_used";
		const db = getServiceDb();
		await db.insert(user).values([
			{ id: U, email: `it-s8-${U}@example.test` },
			{ id: OTHER, email: `it-s8-other-${OTHER}@example.test` },
		]);
		await db.insert(organization).values({ id: ORG_H, name: "Held", slug: `it-held-${ORG_H.slice(0, 8)}` });
		for (const [s8, customer] of [
			[SUB_HELD, "cus_it_s8_org"],
			[SUB_F_OPEN, "cus_it_s8_a"],
			[SUB_F_REFUNDED, "cus_it_s8_b"],
			[SUB_F_VOIDED, "cus_it_s8_c"],
			[SUB_F_NONE, "cus_it_s8_d"],
		] as const) {
			await recordPendingOrgSetup({ userId: U, subscriptionId: s8, customerId: customer, name: "Held", slug: "held" });
		}
		await recordPendingOrgSetup({ userId: OTHER, subscriptionId: SUB_OTHER, customerId: "cus_it_s8_other", name: "O", slug: "o" });
		await db.update(pendingOrgSetups).set({ created_org_id: ORG_H }).where(eq(pendingOrgSetups.subscription_id, SUB_HELD));
		await hold(SUB_HELD, U);
		await hold(SUB_F_OPEN, U);
		await hold(SUB_F_REFUNDED, U, "refunded");
		await hold(SUB_F_VOIDED, U, "voided_unpaid");
		await hold(SUB_OTHER, OTHER);
	});

	afterAll(async () => {
		if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
		else process.env.STRIPE_SECRET_KEY = savedStripeKey;
		const db = getServiceDb();
		await db.delete(paymentHolds).where(inArray(paymentHolds.subscription_id, ALL));
		await db.delete(pendingOrgSetups).where(inArray(pendingOrgSetups.user_id, [U, OTHER]));
		await db.delete(organization).where(eq(organization.id, ORG_H));
		await db.delete(user).where(inArray(user.id, [U, OTHER]));
	});

	it("C92: with an open hold on an ended X, the closer, the link's compare-and-set and close-setup each leave closed_at null", async () => {
		const row = await pendingOrgSetupFor(U, SUB_HELD);
		if (!row) throw new Error("fixture: the held record is missing");
		await expect(settleOpenSetup(row, { sub: canceledX(SUB_HELD) as never, orgId: ORG_H })).resolves.toBe("open");
		expect(await closePendingOrgSetup({ subscriptionId: SUB_HELD, reason: "org_has_plan", refusedReason: "org_has_plan" })).toBeNull();
		fakeStripe.subscriptions.retrieve.mockResolvedValueOnce(canceledX(SUB_HELD));
		const printed: string[] = [];
		const r = await closeSetup({ subscriptionId: SUB_HELD, reason: "it", operator: U }, (line) => printed.push(line));
		expect(r).toMatchObject({ kind: "refused", reason: expect.stringMatching(/open payment hold \(closing\)/) });
		expect((await pendingOrgSetupFor(U, SUB_HELD))?.closed_at).toBeNull();
		// The guard keeps refusing while the hold is open: the setup is still open for the org.
		expect((await openPendingOrgSetupsForOrg(ORG_H)).map((x) => x.subscription_id)).toEqual([SUB_HELD]);
	});

	it("C92: once the hold is released, the same closer closes the setup", async () => {
		await getServiceDb()
			.update(paymentHolds)
			.set({ state: "released", release_reason: "operator", released_at: new Date(), next_check_at: null })
			.where(eq(paymentHolds.subscription_id, SUB_HELD));
		expect(await openPaymentHoldOn(SUB_HELD)).toBeNull();
		const row = await pendingOrgSetupFor(U, SUB_HELD);
		if (!row) throw new Error("fixture: the held record is missing");
		await expect(settleOpenSetup(row, { sub: canceledX(SUB_HELD) as never, orgId: ORG_H })).resolves.toBe("closed");
		expect((await pendingOrgSetupFor(U, SUB_HELD))?.closed_reason).toBe("ended");
	});

	it("§8: forgetPendingOrgSetup drops a record only when no hold names it or the hold proved it never payable", async () => {
		for (const id of [SUB_F_OPEN, SUB_F_REFUNDED, SUB_F_VOIDED, SUB_F_NONE]) {
			await forgetPendingOrgSetup(U, { id, status: "incomplete_expired", metadata: { created_by: U } }, "never_paid");
		}
		expect(await pendingOrgSetupFor(U, SUB_F_OPEN)).not.toBeNull();
		expect(await pendingOrgSetupFor(U, SUB_F_REFUNDED)).not.toBeNull();
		expect(await pendingOrgSetupFor(U, SUB_F_VOIDED)).toBeNull();
		expect(await pendingOrgSetupFor(U, SUB_F_NONE)).toBeNull();
	});

	it("C94: the live check lists the customers of unlinked records with a team, and of closed ones; never another user's", async () => {
		const live = await liveCheckSetupCustomers(U);
		expect(live).toEqual({ kind: "all", customers: expect.arrayContaining(["cus_it_s8_org", "cus_it_s8_a", "cus_it_s8_b"]) });
		const unlinked = await unlinkedPendingOrgSetupCustomers(U);
		expect(unlinked.kind === "all" ? unlinked.customers : []).not.toContain("cus_it_s8_org");
		expect(live.kind === "all" ? live.customers : []).not.toContain("cus_it_s8_other");
	});

	it("paymentHoldsOfPayer reads the payer's open holds and recent refunds — never another payer's, never a voided release", async () => {
		const subs = (await paymentHoldsOfPayer(U)).map((h) => h.subscription_id);
		expect(subs).toEqual(expect.arrayContaining([SUB_F_OPEN, SUB_F_REFUNDED]));
		expect(subs).not.toContain(SUB_F_VOIDED);
		expect(subs).not.toContain(SUB_OTHER);
	});
});

// #6052 (S8 follow-up 4, I14): the closer runs without the payer's lease, so E0 can be opening a hold on
// the same canceled X while the closer closes X's setup. Two real connections, interleaved on purpose:
// E (standing in for E0's `openHold` transaction) has INSERTED the hold and not committed it when the
// closer runs. Under READ COMMITTED the close's `NOT EXISTS` cannot see that uncommitted row, so on dev
// the close lands and the hold commits beneath it — a setup closed while a hold names X (I16 (a)).
// After #6052 the close waits for E's commit, sees the hold, and leaves the setup open.
describeIfDb("pending_org_setups — #6052: the closer's check and close are atomic against a hold being opened", () => {
	const U = randomUUID();
	const X = `sub_it_6052_${randomUUID().slice(0, 8)}`;
	/** E: the hold's own transaction, on a connection of its own. B: polls pg_stat_activity beside it. */
	let e: postgres.Sql;
	let b: postgres.Sql;
	let savedStripeKey: string | undefined;

	beforeAll(async () => {
		savedStripeKey = process.env.STRIPE_SECRET_KEY;
		process.env.STRIPE_SECRET_KEY = "sk_test_integration_never_used";
		const url = process.env.ALETHIA_DATABASE_URL ?? "";
		e = postgres(url, { max: 1 });
		b = postgres(url, { max: 1 });
		await getServiceDb().insert(user).values({ id: U, email: `it-6052-${U}@example.test` });
		await recordPendingOrgSetup({ userId: U, subscriptionId: X, customerId: "cus_it_6052", name: "Race", slug: "race" });
	});

	afterAll(async () => {
		await e.end({ timeout: 1 });
		await b.end({ timeout: 1 });
		if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
		else process.env.STRIPE_SECRET_KEY = savedStripeKey;
		const db = getServiceDb();
		await db.delete(paymentHolds).where(eq(paymentHolds.payer_key, U));
		await db.delete(pendingOrgSetups).where(eq(pendingOrgSetups.user_id, U));
		await db.delete(user).where(eq(user.id, U));
	});

	/**
	 * Resolves once another backend of this database waits on a lock while running a statement on
	 * `payment_holds` (the closer, blocked behind E's insert); resolves false when `stop` fires first or
	 * after ~5s of polling.
	 */
	async function closerWaitsOnHolds(stop: { done: boolean }): Promise<boolean> {
		for (let i = 0; i < 250 && !stop.done; i++) {
			const rows = await b`SELECT 1 FROM pg_stat_activity
				WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%payment_holds%'`;
			if (rows.length > 0) return true;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return false;
	}

	it("a hold inserted before the close and committed after it keeps the setup open, and the closer answers open", async () => {
		const row = await pendingOrgSetupFor(U, X);
		if (!row) throw new Error("fixture: the setup is missing");
		expect(row.closed_at).toBeNull();
		expect(await openPaymentHoldOn(X)).toBeNull();
		fakeStripe.subscriptions.retrieve.mockResolvedValueOnce({
			id: X,
			status: "canceled",
			customer: "cus_it_6052",
			latest_invoice: null,
			metadata: { created_by: U },
		});

		let inserted: () => void = () => undefined;
		const holdInserted = new Promise<void>((resolve) => {
			inserted = resolve;
		});
		// Boxed: a promise resolved WITH a promise adopts it, and E would wait for the closer to finish.
		let started: (box: { closing: Promise<string> }) => void = () => undefined;
		const closerStarted = new Promise<{ closing: Promise<string> }>((resolve) => {
			started = resolve;
		});
		const stop = { done: false };
		// E: E0's statement shape (`openHold`): the insert, guarded by the open-row unique index, then a
		// pause before COMMIT while the closer runs.
		const opening = e.begin(async (tx) => {
			await tx`INSERT INTO payment_holds
				(subscription_id, customer_id, payer_key, invoice_id, state, next_check_at, opened_by)
				VALUES (${X}, 'cus_it_6052', ${U}, ${`in_${X}`}, 'closing', now(), 'purchase')
				ON CONFLICT (subscription_id) WHERE state <> 'released' DO NOTHING`;
			inserted();
			// Commit only once the closer has either finished (dev: it never waits) or is blocked behind
			// this insert (the fix). Either way its read of the holds came while this row was uncommitted.
			const { closing } = await closerStarted;
			return Promise.race([
				closing.then(() => "closer finished"),
				closerWaitsOnHolds(stop).then((waiting) => (waiting ? "closer waiting" : "timed out")),
			]);
		});
		await holdInserted;
		const closing = settleOpenSetup(row);
		started({ closing });
		const whenCommitted = await opening;
		stop.done = true;
		const verdict = await closing;

		// Whichever way the interleaving went, the hold is now committed and open on X.
		expect((await openPaymentHoldOn(X))?.state).toBe("closing");
		// I16 (a): the setup is not closed beneath it, and the closer says so.
		expect((await pendingOrgSetupFor(U, X))?.closed_at).toBeNull();
		expect(verdict).toBe("open");
		// The closer really ran while the hold was uncommitted, and waited behind it.
		expect(whenCommitted).toBe("closer waiting");
	});

	/**
	 * Opens a hold write on ANOTHER subscription on E and keeps its transaction open (its ROW EXCLUSIVE
	 * lock on `payment_holds` held) until `finish` is called; `finish` rolls it back.
	 */
	async function holdWriteInFlight(): Promise<{ finish: () => Promise<void> }> {
		const other = `sub_it_6052_other_${randomUUID().slice(0, 8)}`;
		let ready: () => void = () => undefined;
		const isReady = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const done = e
			.begin(async (tx) => {
				await tx`INSERT INTO payment_holds
					(subscription_id, customer_id, payer_key, invoice_id, state, next_check_at, opened_by)
					VALUES (${other}, 'cus_it_6052', ${U}, ${`in_${other}`}, 'closing', now(), 'purchase')`;
				ready();
				await released;
				throw new Error("rollback");
			})
			.catch(() => undefined);
		await isReady;
		return {
			finish: async () => {
				release();
				await done;
			},
		};
	}

	/** A fresh open setup of U on a fresh subscription, with `held` adding a committed open hold on it. */
	async function freshSetup(held: boolean): Promise<string> {
		const x = `sub_it_6052_${randomUUID().slice(0, 8)}`;
		await recordPendingOrgSetup({ userId: U, subscriptionId: x, customerId: "cus_it_6052", name: "Race", slug: "race" });
		if (held) {
			await getServiceDb().insert(paymentHolds).values({
				subscription_id: x,
				customer_id: "cus_it_6052",
				payer_key: U,
				invoice_id: `in_${x}`,
				state: "closing",
				next_check_at: new Date(),
				opened_by: "purchase",
			});
		}
		return x;
	}

	it("lock_timeout: a closer that cannot take the lock in 2s throws 55P03 with nothing written — the closer, settleOpenSetup and close-setup alike", async () => {
		const x = await freshSetup(false);
		const inFlight = await holdWriteInFlight();
		try {
			const started = Date.now();
			const err = await closePendingOrgSetup({ subscriptionId: x, reason: "ended" }).then(
				() => null,
				(e: unknown) => e,
			);
			expect(pgErrorCode(err)).toBe("55P03");
			expect(Date.now() - started).toBeLessThan(10_000);
			const row = await pendingOrgSetupFor(U, x);
			if (!row) throw new Error("fixture: the setup is missing");
			fakeStripe.subscriptions.retrieve.mockResolvedValueOnce({
				id: x,
				status: "canceled",
				customer: "cus_it_6052",
				latest_invoice: null,
				metadata: { created_by: U },
			});
			// The guard turns this throw into the try-again refusal (openSetupRefusal's catch).
			expect(pgErrorCode(await settleOpenSetup(row).then(() => null, (e: unknown) => e))).toBe("55P03");
			fakeStripe.subscriptions.retrieve.mockResolvedValueOnce({ id: x, status: "canceled", metadata: {} });
			const printed: string[] = [];
			await expect(
				closeSetup({ subscriptionId: x, reason: "it", operator: U }, (line) => printed.push(line)),
			).resolves.toMatchObject({ kind: "refused", reason: expect.stringMatching(/not free within 2s/) });
			expect((await pendingOrgSetupFor(U, x))?.closed_at).toBeNull();
		} finally {
			await inFlight.finish();
		}
		// Once the hold write is gone, the same close lands.
		expect((await closePendingOrgSetup({ subscriptionId: x, reason: "ended" }))?.closed_reason).toBe("ended");
	});

	it("fast path: with a committed open hold on X the close answers null at once, without waiting on the lock", async () => {
		const x = await freshSetup(true);
		const inFlight = await holdWriteInFlight();
		try {
			// Were the lock taken, this would wait behind E and throw 55P03; it resolves null instead.
			await expect(closePendingOrgSetup({ subscriptionId: x, reason: "ended" })).resolves.toBeNull();
			const printed: string[] = [];
			fakeStripe.subscriptions.retrieve.mockResolvedValueOnce({ id: x, status: "canceled", metadata: {} });
			await expect(
				closeSetup({ subscriptionId: x, reason: "it", operator: U }, (line) => printed.push(line)),
			).resolves.toMatchObject({ kind: "refused", reason: expect.stringMatching(/open payment hold \(closing\)/) });
			expect((await pendingOrgSetupFor(U, x))?.closed_at).toBeNull();
		} finally {
			await inFlight.finish();
		}
	});
});
