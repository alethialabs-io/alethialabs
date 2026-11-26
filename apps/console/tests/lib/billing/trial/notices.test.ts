// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The local-trial notice sweep (lib/billing/trial/notices.ts): each email at most once per trial,
// only while it is true, and retried when the send fails. The pass runs for real against an
// in-memory store that keeps the Postgres store's contract — `due` selects, `claim` is a
// compare-and-set that re-checks everything in one step, `unclaim` gives back only its own claim.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/email/billing-email", () => ({ sendLocalTrialNoticeEmail: vi.fn() }));

import {
	type DeliverTrialNotice,
	type LocalTrialNotice,
	runTrialNoticeSweep,
	TRIAL_ENDED_WINDOW_MS,
	TRIAL_ENDING_LEAD_MS,
	type TrialNoticeCandidate,
	type TrialNoticeStore,
} from "@/lib/billing/trial/notices";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-12-10T12:00:00Z");

/** One organization_billing row, with only the columns the sweep reads. */
interface Row {
	organizationId: string;
	status: string;
	plan: string;
	stripeSubscriptionId: string | null;
	paddleSubscriptionId: string | null;
	currentPeriodEnd: Date | null;
	trialEndingNoticeFor: Date | null;
	trialEndedNoticeFor: Date | null;
}

/** A local trial for `orgId` ending at `end`. */
function localTrial(orgId: string, end: Date, over: Partial<Row> = {}): Row {
	return {
		organizationId: orgId,
		status: "trialing",
		plan: "team",
		stripeSubscriptionId: null,
		paddleSubscriptionId: null,
		currentPeriodEnd: end,
		trialEndingNoticeFor: null,
		trialEndedNoticeFor: null,
		...over,
	};
}

/** The in-memory store: the same predicates as the SQL, evaluated over `rows`. */
function memoryStore(rows: Row[]): TrialNoticeStore & { rows: Row[] } {
	const isLocal = (r: Row) =>
		r.status === "trialing" && r.plan === "team" && r.stripeSubscriptionId === null && r.paddleSubscriptionId === null;
	const inWindow = (n: LocalTrialNotice, r: Row, now: Date) => {
		const end = r.currentPeriodEnd?.getTime();
		if (end === undefined) return false;
		return n === "ending"
			? end > now.getTime() && end <= now.getTime() + TRIAL_ENDING_LEAD_MS
			: end <= now.getTime() && end > now.getTime() - TRIAL_ENDED_WINDOW_MS;
	};
	const claimOf = (n: LocalTrialNotice, r: Row) => (n === "ending" ? r.trialEndingNoticeFor : r.trialEndedNoticeFor);
	const setClaim = (n: LocalTrialNotice, r: Row, v: Date | null) => {
		if (n === "ending") r.trialEndingNoticeFor = v;
		else r.trialEndedNoticeFor = v;
	};
	const unclaimed = (n: LocalTrialNotice, r: Row) => claimOf(n, r)?.getTime() !== r.currentPeriodEnd?.getTime();
	return {
		rows,
		async due(n, now, limit) {
			return rows
				.filter((r) => isLocal(r) && inWindow(n, r, now) && unclaimed(n, r))
				.flatMap((r) => (r.currentPeriodEnd ? [{ organizationId: r.organizationId, trialEnd: r.currentPeriodEnd }] : []))
				.slice(0, limit);
		},
		async claim(n, c, now) {
			const r = rows.find((x) => x.organizationId === c.organizationId);
			if (!r || !isLocal(r) || !inWindow(n, r, now) || !unclaimed(n, r)) return false;
			if (r.currentPeriodEnd?.getTime() !== c.trialEnd.getTime()) return false;
			setClaim(n, r, r.currentPeriodEnd);
			return true;
		},
		async unclaim(n, c) {
			const r = rows.find((x) => x.organizationId === c.organizationId);
			if (r && claimOf(n, r)?.getTime() === c.trialEnd.getTime()) setClaim(n, r, null);
		},
	};
}

/** Runs one pass with `deliver` (default: sends to everybody), recording each delivery. */
async function pass(store: TrialNoticeStore, now: Date = NOW, deliver?: DeliverTrialNotice) {
	const sent: Array<{ notice: LocalTrialNotice; c: TrialNoticeCandidate }> = [];
	const send: DeliverTrialNotice =
		deliver ??
		(async (notice, c) => {
			sent.push({ notice, c });
			return true;
		});
	const result = await runTrialNoticeSweep(now, { store, deliver: send, log: () => {} });
	return { result, sent };
}

describe("the reminder before a local trial ends", () => {
	it("is sent inside the three-day window, and only once across passes", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() + 2 * DAY))]);
		const first = await pass(store);
		expect(first.sent.map((s) => [s.notice, s.c.organizationId])).toEqual([["ending", "org-1"]]);
		expect(first.result.endingSent).toBe(1);

		const second = await pass(store, new Date(NOW.getTime() + 60 * 60 * 1000));
		expect(second.sent).toEqual([]);
	});

	it("is not sent before the window opens", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() + 4 * DAY))]);
		expect((await pass(store)).sent).toEqual([]);
	});

	it("is never sent to an org that converted, a Stripe trial, or a paid plan", async () => {
		const end = new Date(NOW.getTime() + DAY);
		const store = memoryStore([
			localTrial("converted", end, { paddleSubscriptionId: "sub_paddle", status: "active" }),
			localTrial("stripe-trial", end, { stripeSubscriptionId: "sub_stripe" }),
			localTrial("paid", end, { status: "active" }),
		]);
		expect((await pass(store)).sent).toEqual([]);
	});

	it("is sent once when two passes overlap", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() + DAY))]);
		const [a, b] = await Promise.all([pass(store), pass(store)]);
		expect(a.sent.length + b.sent.length).toBe(1);
		expect(a.result.claimLost + b.result.claimLost).toBe(1);
	});

	it("is not sent when the org converts between selection and claim", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() + DAY))]);
		const realDue = store.due.bind(store);
		store.due = async (n, now, limit) => {
			const found = await realDue(n, now, limit);
			store.rows[0].paddleSubscriptionId = "sub_paddle";
			return found;
		};
		const { sent, result } = await pass(store);
		expect(sent).toEqual([]);
		expect(result.claimLost).toBe(1);
	});

	it("gives the claim back when the send fails, and the next pass sends it", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() + DAY))]);
		await expect(
			pass(store, NOW, async () => {
				throw new Error("SES throttled");
			}),
		).rejects.toThrow(/trial notice sweep: 1 failed — ending for org org-1: SES throttled/);
		expect(store.rows[0].trialEndingNoticeFor).toBeNull();

		const retry = await pass(store, new Date(NOW.getTime() + 60 * 60 * 1000));
		expect(retry.sent.map((s) => s.notice)).toEqual(["ending"]);
	});

	it("keeps the claim when the org has no owner to send to", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() + DAY))]);
		const { result } = await pass(store, NOW, async () => false);
		expect(result.noRecipient).toBe(1);
		expect((await pass(store)).sent).toEqual([]);
	});

	it("is owed again when the trial is extended to a new end", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() + DAY))]);
		await pass(store);
		const extended = new Date(NOW.getTime() + 10 * DAY);
		store.rows[0].currentPeriodEnd = extended;
		expect((await pass(store)).sent).toEqual([]);
		const later = await pass(store, new Date(extended.getTime() - 2 * DAY));
		expect(later.sent.map((s) => [s.notice, s.c.trialEnd.toISOString()])).toEqual([["ending", extended.toISOString()]]);
	});
});

describe("the notice once a local trial has ended", () => {
	it("is sent once after the end, and the reminder is not sent late", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() - 60 * 60 * 1000))]);
		const first = await pass(store);
		expect(first.sent.map((s) => s.notice)).toEqual(["ended"]);
		expect(first.result.endedSent).toBe(1);
		expect((await pass(store)).sent).toEqual([]);
	});

	it("follows the reminder for the same trial", async () => {
		const end = new Date(NOW.getTime() + DAY);
		const store = memoryStore([localTrial("org-1", end)]);
		expect((await pass(store)).sent.map((s) => s.notice)).toEqual(["ending"]);
		expect((await pass(store, new Date(end.getTime() + 60 * 1000))).sent.map((s) => s.notice)).toEqual(["ended"]);
	});

	it("is not sent for a trial that ended more than seven days ago", async () => {
		const store = memoryStore([localTrial("org-1", new Date(NOW.getTime() - 8 * DAY))]);
		expect((await pass(store)).sent).toEqual([]);
	});
});
