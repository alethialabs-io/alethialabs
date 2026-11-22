// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Telling a card-less trial that ran out from a customer's cancellation (lib/billing/trial/end.ts,
// REL-L19 #6907). The two get different emails; the row write is the same guarded sync either way.

import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { isCardlessTrialEnd, TRIAL_END_TOLERANCE_SECONDS } from "@/lib/billing/trial/end";

const TRIAL_END = 1_796_083_200;

/** A deleted subscription with the fields the predicate reads. */
function sub(over: Record<string, unknown> = {}): Stripe.Subscription {
	const fixture: unknown = {
		id: "sub_trial",
		object: "subscription",
		status: "canceled",
		default_payment_method: null,
		trial_end: TRIAL_END,
		ended_at: TRIAL_END,
		canceled_at: TRIAL_END,
		trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
		...over,
	};
	return fixture as Stripe.Subscription;
}

describe("isCardlessTrialEnd", () => {
	it("is true for a card-less trial Stripe cancelled at its trial end", () => {
		expect(isCardlessTrialEnd(sub())).toBe(true);
		expect(isCardlessTrialEnd(sub({ ended_at: TRIAL_END + TRIAL_END_TOLERANCE_SECONDS }))).toBe(true);
	});

	it("falls back to canceled_at when ended_at is missing", () => {
		expect(isCardlessTrialEnd(sub({ ended_at: null }))).toBe(true);
	});

	it("is false for a customer who cancelled mid-trial", () => {
		expect(isCardlessTrialEnd(sub({ ended_at: TRIAL_END - 10 * 86_400, canceled_at: TRIAL_END - 10 * 86_400 }))).toBe(false);
	});

	it("is false when a payment method is on the subscription", () => {
		expect(isCardlessTrialEnd(sub({ default_payment_method: "pm_1" }))).toBe(false);
		expect(isCardlessTrialEnd(sub({ default_payment_method: { id: "pm_1" } }))).toBe(false);
	});

	it("is false for a subscription that was never a cancel-at-end trial", () => {
		expect(isCardlessTrialEnd(sub({ trial_settings: null }))).toBe(false);
		expect(isCardlessTrialEnd(sub({ trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } } }))).toBe(false);
		expect(isCardlessTrialEnd(sub({ trial_end: null }))).toBe(false);
		expect(isCardlessTrialEnd(sub({ ended_at: null, canceled_at: null }))).toBe(false);
	});

	it("is false for a subscription that has not ended", () => {
		expect(isCardlessTrialEnd(sub({ status: "trialing" }))).toBe(false);
	});
});
