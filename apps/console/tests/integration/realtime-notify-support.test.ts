// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6130, ADR 0005 D3): what the support_cases change triggers in lib/db/programmables.sql
// actually NOTIFY on `alethia_change`, against real Postgres — and, through the pure routing rule,
// who that notice reaches.
//
// DETERMINISM — the same sentinel discipline as realtime-notify.test.ts: after each operation the
// test commits a sentinel NOTIFY of its own and waits for it on a dedicated LISTEN connection, so
// what arrived before the sentinel is exactly what the operation emitted. A ZERO below is a real
// zero, and every zero has a control in this file that emits one.
//
// The writes are the ones the two apps make, column for column: a customer reply
// (app/server/actions/support.ts `postCaseMessage`) and a staff reply (apps/admin `postStaffReply`)
// both insert a support_messages row and bump the case's last_message_at / last_author_type /
// status in one transaction; an INTERNAL staff note inserts the message only; assigning a case
// writes assigned_staff_id + updated_at.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { supportCases, supportMessages } from "@/lib/db/schema";
import { type ChangeNotice, keysFor, subscriptionKeys } from "@/lib/realtime/routing";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const REQUESTER = randomUUID(); // opened the case
const ADMIN = randomUUID(); // an owner/admin of ORG — holds manage_support
const TEAMMATE = randomUUID(); // a plain member of ORG
const STAFF = randomUUID(); // an Alethia staff user (the admin app)

interface Notice {
	t: string;
	id: string | null;
	o: string | null;
	u: string | null;
	p: string | null;
	n?: string;
}

const db = () => getServiceDb();
let listener: ReturnType<typeof postgres>;
const heard: Notice[] = [];
const created: string[] = [];

/**
 * Waits until the sentinel `n` has been heard, then returns (and forgets) every support notice
 * before it ABOUT THIS FILE'S CASES. The channel is database-wide and other suites open cases too
 * (the tenancy suite seeds two), so a notice is attributed by its id, never by arrival alone.
 */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "support" && x.id !== null && created.includes(x.id));
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the support notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** Inserts a case for REQUESTER in ORG (status `open`). Returns its id. */
async function insertCase(subject: string): Promise<string> {
	const [row] = await db()
		.insert(supportCases)
		.values({
			user_id: REQUESTER,
			org_id: ORG,
			type: "technical",
			category: "other",
			severity: "normal",
			status: "open",
			subject,
			context: {},
			contact: { notifyEmail: "it-6130@example.test", channel: "email" },
			last_author_type: "customer",
		})
		.returning({ id: supportCases.id });
	created.push(row.id);
	return row.id;
}

/**
 * Opens a case and CONSUMES its own insert notice, so the operation a test measures next starts
 * from a drained channel (otherwise the insert hint would be counted against that operation).
 */
async function openCase(subject = "it-6130 case"): Promise<string> {
	let id = "";
	const notices = await emitted(async () => {
		id = await insertCase(subject);
	});
	expect(notices).toHaveLength(1);
	return id;
}

/** A public reply exactly as both apps write one: the message, then the case bump, in one transaction. */
function publicReply(caseId: string, author: "customer" | "staff", authorId: string) {
	return db().transaction(async (tx) => {
		await tx.insert(supportMessages).values({
			case_id: caseId,
			author_type: author,
			author_id: authorId,
			author_name: author === "staff" ? "Alethia Support" : "Requester",
			body: `it-6130 ${author} reply`,
		});
		await tx
			.update(supportCases)
			.set({
				last_message_at: sql`now()`,
				last_author_type: author,
				status: author === "staff" ? "pending_customer" : "pending_support",
				updated_at: sql`now()`,
			})
			.where(eq(supportCases.id, caseId));
	});
}

/** Whether a change stream with this identity would receive `notice` (the bus matches on these keys). */
function hears(notice: Notice, userId: string, orgId: string, manageSupport: boolean): boolean {
	const change: ChangeNotice = { kind: "change", t: "support", id: notice.id, o: notice.o, u: notice.u, p: notice.p };
	const held = subscriptionKeys({ userId, orgId }, { platformView: false, manageSupport });
	return keysFor(change).some((route) => held.includes(route.key));
}

describeIfDb("support_cases change triggers — what reaches alethia_change (#6130)", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		if (created.length) {
			await db().delete(supportMessages).where(inArray(supportMessages.case_id, created));
			await db().delete(supportCases).where(inArray(supportCases.id, created));
		}
	});

	it("a new case emits exactly one notice: its id, its org, its requester — identifiers only", async () => {
		let id = "";
		const notices = await emitted(async () => {
			id = await insertCase("it-6130 case");
		});
		expect(notices).toEqual([{ t: "support", id, o: ORG, u: REQUESTER, p: null }]);
	});

	it("a STAFF reply emits exactly one hint, reaching the requester and the org's admins and nobody else", async () => {
		const id = await openCase();
		const notices = await emitted(() => publicReply(id, "staff", STAFF));
		expect(notices).toEqual([{ t: "support", id, o: ORG, u: REQUESTER, p: null }]);

		const [notice] = notices;
		expect(hears(notice, REQUESTER, ORG, false), "the requester").toBe(true);
		expect(hears(notice, ADMIN, ORG, true), "an owner/admin (manage_support)").toBe(true);
		expect(hears(notice, TEAMMATE, ORG, false), "a teammate RLS shows none of it to").toBe(false);
		expect(hears(notice, REQUESTER, OTHER_ORG, true), "the requester's stream on another org").toBe(false);
	});

	it("a customer reply emits exactly one hint (the message insert itself emits none)", async () => {
		const id = await openCase();
		expect(await emitted(() => publicReply(id, "customer", REQUESTER))).toHaveLength(1);
	});

	it("an INTERNAL staff note emits NOTHING — it bumps no case column, and the customer never sees it", async () => {
		const id = await openCase();
		const notices = await emitted(() =>
			db().insert(supportMessages).values({
				case_id: id,
				author_type: "staff",
				author_id: STAFF,
				author_name: "Alethia Support",
				body: "it-6130 internal note",
				is_internal: true,
			}),
		);
		expect(notices).toEqual([]);
	});

	it("unrelated column updates emit NOTHING: an assignment, a bare updated_at, the contact prefs", async () => {
		const id = await openCase();
		expect(
			await emitted(() =>
				db().update(supportCases).set({ assigned_staff_id: STAFF, updated_at: sql`now()` }).where(eq(supportCases.id, id)),
			),
		).toEqual([]);
		expect(
			await emitted(() => db().update(supportCases).set({ updated_at: sql`now()` }).where(eq(supportCases.id, id))),
		).toEqual([]);
		expect(
			await emitted(() =>
				db()
					.update(supportCases)
					.set({ contact: { notifyEmail: "it-6130-new@example.test", channel: "in_app" } })
					.where(eq(supportCases.id, id)),
			),
		).toEqual([]);
		// A status write to the status it already holds changes nothing the console shows.
		expect(
			await emitted(() => db().update(supportCases).set({ status: "open" }).where(eq(supportCases.id, id))),
		).toEqual([]);
	});

	it("a status change emits exactly one (the control for the zeros above)", async () => {
		const id = await openCase();
		expect(
			await emitted(() =>
				db().update(supportCases).set({ status: "closed", closed_at: new Date() }).where(eq(supportCases.id, id)),
			),
		).toEqual([{ t: "support", id, o: ORG, u: REQUESTER, p: null }]);
	});

	it("a deleted case emits one, from the OLD row, so the list drops it", async () => {
		const id = await openCase();
		expect(await emitted(() => db().delete(supportCases).where(eq(supportCases.id, id)))).toEqual([
			{ t: "support", id, o: ORG, u: REQUESTER, p: null },
		]);
	});
});
