// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An off-Stripe AI grant (EA-3's AI tier) lapses on its own at the row's term end, as an off-Stripe
// plan grant does; a Stripe-backed AI tier is never touched by that rule.

import { describe, expect, it } from "vitest";
import { type AiTierBillingFields, billingAiTier } from "@/lib/billing/ai-plan";

const NOW = new Date("2027-01-15T00:00:00Z");
const PAST = new Date("2027-01-01T00:00:00Z");
const FUTURE = new Date("2027-03-01T00:00:00Z");

/** A billing row with an active off-Stripe AI Plus grant, overridden by `over`. */
function row(over: Partial<AiTierBillingFields> = {}): AiTierBillingFields {
	return {
		aiTier: "ai_plus",
		aiSubscriptionStatus: "active",
		aiStripeSubscriptionId: null,
		aiPaddleSubscriptionId: null,
		stripeSubscriptionId: null,
		paddleSubscriptionId: null,
		currentPeriodEnd: FUTURE,
		...over,
	};
}

describe("billingAiTier", () => {
	it("keeps an off-Stripe AI grant inside its term", () => {
		expect(billingAiTier(row(), NOW)).toBe("ai_plus");
	});

	it("lapses an off-Stripe AI grant past its term end", () => {
		expect(billingAiTier(row({ currentPeriodEnd: PAST }), NOW)).toBe("ai_free");
	});

	it("never lapses an open-ended grant", () => {
		expect(billingAiTier(row({ currentPeriodEnd: null }), NOW)).toBe("ai_plus");
	});

	it("leaves a Stripe-backed AI tier to its subscription status, whatever the term end says", () => {
		expect(billingAiTier(row({ aiStripeSubscriptionId: "sub_ai", currentPeriodEnd: PAST }), NOW)).toBe("ai_plus");
	});

	it("does not lapse on a row whose plan is a Stripe subscription (that date is its renewal)", () => {
		expect(billingAiTier(row({ stripeSubscriptionId: "sub_plan", currentPeriodEnd: PAST }), NOW)).toBe("ai_plus");
	});

	it("keeps effectiveAiTier's rules: a non-live status is free, and so is no tier", () => {
		expect(billingAiTier(row({ aiSubscriptionStatus: "canceled" }), NOW)).toBe("ai_free");
		expect(billingAiTier(row({ aiTier: null, aiSubscriptionStatus: null }), NOW)).toBe("ai_free");
	});
});
