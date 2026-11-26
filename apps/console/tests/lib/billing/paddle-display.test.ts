// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How a Paddle-routed billing row reads on the plan card (L4): a scheduled cancellation is
// `cancel_effective_at`, a past-due subscription carries its 7-day grace end (O8), and a local
// card-less trial reads as trialing until its end and as Hobby after it. Plus the local trial's own
// facts and the predicate that lets a checkout convert it.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PAST_DUE_GRACE_MS } from "@/lib/billing/plan";
import { isLocalTrialRow, LOCAL_TRIAL_DAYS, localTrialGrant } from "@/lib/billing/trial/local";
import { paddleSummaryFields } from "@/lib/rpc/procedures/billing";

const NOW = new Date("2026-11-25T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A Paddle row with only the fields the summary reads. */
function row(over: Partial<Parameters<typeof paddleSummaryFields>[0]> = {}): Parameters<typeof paddleSummaryFields>[0] {
	return {
		plan: "team",
		status: "active",
		currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
		currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
		cancelEffectiveAt: null,
		stripeSubscriptionId: null,
		paddleSubscriptionId: "sub_1",
		...over,
	};
}

describe("paddleSummaryFields", () => {
	it("an active subscription renews at its period end", () => {
		expect(paddleSummaryFields(row(), NOW)).toEqual({
			plan: "team",
			status: "active",
			cancelAtPeriodEnd: false,
			currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY).toISOString(),
			pastDueGraceEndsAt: null,
		});
	});

	it("a scheduled cancellation reads as canceling at cancel_effective_at", () => {
		const at = new Date(NOW.getTime() + 20 * DAY);
		const out = paddleSummaryFields(row({ cancelEffectiveAt: at }), NOW);
		expect(out.cancelAtPeriodEnd).toBe(true);
		expect(out.currentPeriodEnd).toBe(at.toISOString());
	});

	it("past due carries the grace end while it lasts, and no renewal date", () => {
		const start = new Date(NOW.getTime() - 2 * DAY);
		const out = paddleSummaryFields(row({ status: "past_due", currentPeriodStart: start }), NOW);
		expect(out.status).toBe("past_due");
		expect(out.currentPeriodEnd).toBeNull();
		expect(out.pastDueGraceEndsAt).toBe(new Date(start.getTime() + PAST_DUE_GRACE_MS).toISOString());
		const lapsed = paddleSummaryFields(row({ status: "past_due", currentPeriodStart: new Date(NOW.getTime() - 8 * DAY) }), NOW);
		expect(lapsed.pastDueGraceEndsAt).toBeNull();
	});

	it("a local trial reads as trialing until its end, then as Hobby", () => {
		const grant = localTrialGrant(new Date(NOW.getTime() - 5 * DAY));
		const trial = { ...row(grant), paddleSubscriptionId: null };
		expect(paddleSummaryFields(trial, NOW)).toMatchObject({ plan: "team", status: "trialing" });
		const later = new Date(NOW.getTime() + (LOCAL_TRIAL_DAYS + 1) * DAY);
		expect(paddleSummaryFields(trial, later)).toEqual({
			plan: "community",
			status: "none",
			cancelAtPeriodEnd: false,
			currentPeriodEnd: null,
			pastDueGraceEndsAt: null,
		});
	});
});

describe("the local card-less trial", () => {
	it("is a 30-day trialing Pro grant routed to Paddle, with no provider object", () => {
		const grant = localTrialGrant(NOW);
		expect(grant).toMatchObject({ plan: "team", status: "trialing", billingProvider: "paddle", seats: null });
		expect(grant.currentPeriodEnd.getTime() - NOW.getTime()).toBe(LOCAL_TRIAL_DAYS * DAY);
	});

	it("is recognised only without any provider subscription", () => {
		const base = { status: "trialing", plan: "team", stripeSubscriptionId: null, paddleSubscriptionId: null };
		expect(isLocalTrialRow(base)).toBe(true);
		expect(isLocalTrialRow({ ...base, paddleSubscriptionId: "sub_1" })).toBe(false);
		expect(isLocalTrialRow({ ...base, stripeSubscriptionId: "sub_s" })).toBe(false);
		expect(isLocalTrialRow({ ...base, status: "active" })).toBe(false);
		expect(isLocalTrialRow(null)).toBe(false);
	});
});
