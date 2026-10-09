// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the Elench drafts retention sweep and the erasure register row, against real Postgres
// (ADR 0001 slice 6, §9). Every row's timestamps are written on the database's clock, which is the
// clock the sweep reads, so a boundary row (23 h / 25 h, 29 / 31 days) is on the side it says.
//
// The sweep is global, so it may also act on rows other suites left behind; every assertion here is
// about this file's own rows, by id, never about the sweep's totals.

import { randomUUID } from "node:crypto";
import { eq, inArray, type SQL, sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { type ElenchDraft, elenchDrafts, type NewElenchDraft } from "@/lib/db/schema";
import { sweepElenchDrafts } from "@/lib/elench/drafts-sweep";
import { statementFor } from "@/lib/privacy/erasure-executor";
import { ERASURE_RULES } from "@/lib/privacy/erasure-plan";
import { describeIfDb } from "./db";

const users: string[] = [];

/** A fresh user id, remembered for cleanup. */
function freshUser(): string {
	const id = randomUUID();
	users.push(id);
	return id;
}

/** An `active` draft of `userId` in `orgId` (the personal org unless named). */
function active(userId: string, orgId: string = userId): NewElenchDraft {
	return {
		user_id: userId,
		org_id: orgId,
		conversation_id: randomUUID(),
		revision: 1,
		status: "active",
		text: "kubeconfig: secret-ish paste",
		mentions: [],
		artifacts: [],
	};
}

/** A `sending` draft of `userId` under a fresh claim of `kind`. */
function sending(userId: string, kind: "first" | "later"): NewElenchDraft {
	return {
		...active(userId),
		revision: 2,
		status: "sending",
		claim_token: randomUUID(),
		claim_turn_id: randomUUID(),
		claim_kind: kind,
		claimed_at: new Date(),
	};
}

/** Inserts `row`, then backdates the columns `ages` names on the database's clock. */
async function insertAged(row: NewElenchDraft, ages: Partial<Record<"updated_at" | "discarded_at" | "claimed_at", SQL>>): Promise<ElenchDraft> {
	const [inserted] = await getServiceDb().insert(elenchDrafts).values(row).returning();
	if (!inserted) throw new Error("no row inserted");
	if (Object.keys(ages).length === 0) return inserted;
	const [aged] = await getServiceDb()
		.update(elenchDrafts)
		.set(ages)
		.where(eq(elenchDrafts.id, inserted.id))
		.returning();
	if (!aged) throw new Error("no row aged");
	return aged;
}

/** The row with `id` as it now stands, or undefined once deleted. */
async function reread(id: string): Promise<ElenchDraft | undefined> {
	const [row] = await getServiceDb().select().from(elenchDrafts).where(eq(elenchDrafts.id, id));
	return row;
}

const ago = (interval: string): SQL => sql`now() - ${interval}::interval`;

describeIfDb("the Elench drafts retention sweep against Postgres", () => {
	afterAll(async () => {
		if (users.length > 0) {
			await getServiceDb().delete(elenchDrafts).where(inArray(elenchDrafts.user_id, users));
		}
	});

	it("deletes a draft discarded 25 h ago and keeps one discarded 23 h ago", async () => {
		const u = freshUser();
		const discarded = { ...active(u), status: "discarded" as const, discarded_at: new Date() };
		const old = await insertAged(discarded, { discarded_at: ago("25 hours") });
		const recent = await insertAged({ ...discarded, conversation_id: randomUUID() }, {
			discarded_at: ago("23 hours"),
		});
		await sweepElenchDrafts(getServiceDb());
		expect(await reread(old.id)).toBeUndefined();
		expect(await reread(recent.id)).toMatchObject({ status: "discarded" });
	});

	it("deletes an active draft unwritten for 31 days and keeps one unwritten for 29", async () => {
		const u = freshUser();
		const old = await insertAged(active(u), { updated_at: ago("31 days") });
		const recent = await insertAged(active(u), { updated_at: ago("29 days") });
		await sweepElenchDrafts(getServiceDb());
		expect(await reread(old.id)).toBeUndefined();
		expect(await reread(recent.id)).toMatchObject({ status: "active", revision: 1 });
	});

	it("deletes a 31-day-old draft in an org other than the personal one (membership is not consulted)", async () => {
		const u = freshUser();
		const otherOrg = randomUUID();
		const inOther = await insertAged(active(u, otherOrg), { updated_at: ago("31 days") });
		await sweepElenchDrafts(getServiceDb());
		expect(await reread(inOther.id)).toBeUndefined();
	});

	it("never touches a sending draft whose claim is live, however old the draft", async () => {
		const u = freshUser();
		// A heartbeat renews claimed_at, never updated_at: a live claim on a 40-day-old draft.
		const live = await insertAged(sending(u, "later"), {
			updated_at: ago("40 days"),
			claimed_at: ago("10 seconds"),
		});
		await sweepElenchDrafts(getServiceDb());
		const after = await reread(live.id);
		expect(after).toMatchObject({
			status: "sending",
			claim_token: live.claim_token,
			text: live.text,
			revision: live.revision,
		});
	});

	it("settles a silent first-turn claim with its words intact, and does not then delete it", async () => {
		const u = freshUser();
		const silent = await insertAged(sending(u, "first"), {
			updated_at: ago("40 days"),
			claimed_at: ago("10 minutes"),
		});
		const result = await sweepElenchDrafts(getServiceDb());
		expect(result.settled).toBeGreaterThanOrEqual(1);
		const after = await reread(silent.id);
		expect(after).toMatchObject({
			status: "active",
			claim_token: null,
			text: silent.text,
			revision: silent.revision + 1,
			failed_send: expect.objectContaining({ turnId: silent.claim_turn_id, error: "lease", uncertain: false }),
		});
	});

	it("settles a silent later-turn claim whose thread holds nothing as released, uncertain", async () => {
		const u = freshUser();
		const silent = await insertAged(sending(u, "later"), { claimed_at: ago("10 minutes") });
		await sweepElenchDrafts(getServiceDb());
		expect(await reread(silent.id)).toMatchObject({
			status: "active",
			text: silent.text,
			failed_send: expect.objectContaining({ turnId: silent.claim_turn_id, uncertain: true }),
		});
	});

	it("two overlapping runs settle each claim once and delete each row once", async () => {
		const u = freshUser();
		const silent = await insertAged(sending(u, "first"), { claimed_at: ago("10 minutes") });
		const stale = await Promise.all(
			Array.from({ length: 6 }, () => insertAged(active(u), { updated_at: ago("31 days") })),
		);
		const [a, b] = await Promise.all([
			sweepElenchDrafts(getServiceDb()),
			sweepElenchDrafts(getServiceDb()),
		]);
		expect(a.settled + b.settled).toBeGreaterThanOrEqual(1);
		// One settle only: a second would have bumped the revision again.
		expect(await reread(silent.id)).toMatchObject({ status: "active", revision: silent.revision + 1 });
		for (const row of stale) expect(await reread(row.id)).toBeUndefined();
	});

	it("is bounded per run: a backlog past pageSize × maxPages drains over later runs", async () => {
		const u = freshUser();
		// Every stale row anywhere in the table is a candidate; clear the field first so the bound
		// below counts only this test's rows.
		await sweepElenchDrafts(getServiceDb());
		const rows = await Promise.all(
			Array.from({ length: 5 }, () => insertAged(active(u), { updated_at: ago("31 days") })),
		);
		const first = await sweepElenchDrafts(getServiceDb(), { pageSize: 2, maxPages: 2 });
		expect(first.staleDeleted).toBe(4);
		const left = (await Promise.all(rows.map((r) => reread(r.id)))).filter((r) => r !== undefined);
		expect(left).toHaveLength(1);
		const second = await sweepElenchDrafts(getServiceDb(), { pageSize: 2, maxPages: 2 });
		expect(second.staleDeleted).toBe(1);
	});

	it("the erasure register's elench_drafts row erases the subject's drafts in every org and no one else's", async () => {
		const rule = ERASURE_RULES.find((r) => r.table === "elench_drafts");
		expect(rule?.disposition).toBe("erase");
		if (!rule) return;

		const subject = freshUser();
		const teammate = freshUser();
		const orgB = randomUUID();
		const own = await insertAged(active(subject), {});
		const inOrgB = await insertAged(active(subject, orgB), {});
		const theirs = await insertAged(active(teammate, orgB), {});

		const statement = statementFor(rule, { userId: subject, personalOrgId: subject });
		if (!statement) throw new Error("an erase rule built no statement");
		await getServiceDb().execute(statement);

		expect(await reread(own.id)).toBeUndefined();
		expect(await reread(inOrgB.id)).toBeUndefined();
		expect(await reread(theirs.id)).toMatchObject({ user_id: teammate });
	});
});
