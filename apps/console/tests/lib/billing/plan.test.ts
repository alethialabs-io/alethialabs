// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	COMMUNITY_ENTITLEMENTS,
	entitlementStatus,
	hasAiSubscription,
	hasPlanSubscription,
	hasProviderSubscription,
	isBillingActive,
	isManualGrantExpired,
	PAST_DUE_GRACE_MS,
	planEntitlements,
	resolvePlanEntitlements,
} from "@/lib/billing/plan";

describe("planEntitlements", () => {
	it("community is single-tenant with every paid feature off", () => {
		const e = planEntitlements("community");
		expect(e.organizations).toBe(false);
		expect(e.teams).toBe(false);
		expect(e.sso).toBe(false);
		expect(e.quotas.maxConcurrentJobs).toBe(2);
		expect(e.quotas.includedRunnerMinutes).toBe(200);
	});

	it("does not carry AI budgets — AI is a standalone product now", () => {
		// AI was decoupled from the org plan (lib/billing/ai-plan.ts); no plan grants it.
		expect("ai" in planEntitlements("community")).toBe(false);
		expect("ai" in planEntitlements("team")).toBe(false);
		expect("ai" in planEntitlements("enterprise")).toBe(false);
	});

	it("team unlocks organizations + raises quotas", () => {
		const e = planEntitlements("team");
		expect(e.organizations).toBe(true);
		expect(e.teams).toBe(false); // teams is enterprise-only
		expect(e.quotas.maxConcurrentJobs).toBe(8);
		expect(e.quotas.includedRunnerMinutes).toBe(500);
	});

	it("enterprise unlocks governance features + unlimited concurrency", () => {
		const e = planEntitlements("enterprise");
		expect(e.organizations).toBe(true);
		expect(e.teams).toBe(true);
		expect(e.customRoles).toBe(true);
		expect(e.activityExport).toBe(true);
		expect(e.sso).toBe(true);
		expect(e.quotas.maxConcurrentJobs).toBeNull(); // unlimited
		expect(e.quotas.includedRunnerMinutes).toBe(20_000);
	});

	it("entitlements grow monotonically up the ladder", () => {
		const c = planEntitlements("community");
		const t = planEntitlements("team");
		expect(t.quotas.includedRunnerMinutes).toBeGreaterThan(
			c.quotas.includedRunnerMinutes,
		);
	});
});

describe("isBillingActive", () => {
	it("is true only while the subscription is live", () => {
		expect(isBillingActive("active")).toBe(true);
		expect(isBillingActive("trialing")).toBe(true);
	});

	it("is false for every non-live status", () => {
		for (const s of ["none", "past_due", "canceled"] as const) {
			expect(isBillingActive(s)).toBe(false);
		}
	});
});

describe("resolvePlanEntitlements", () => {
	it("grants the plan's entitlements while the subscription is live", () => {
		expect(resolvePlanEntitlements("team", "active")).toEqual(
			planEntitlements("team"),
		);
		expect(resolvePlanEntitlements("enterprise", "trialing")).toEqual(
			planEntitlements("enterprise"),
		);
	});

	it("falls back to the community baseline when not live", () => {
		expect(resolvePlanEntitlements("team", "canceled")).toEqual(
			COMMUNITY_ENTITLEMENTS,
		);
		expect(resolvePlanEntitlements("enterprise", "past_due")).toEqual(
			COMMUNITY_ENTITLEMENTS,
		);
		expect(resolvePlanEntitlements("team", "none")).toEqual(
			COMMUNITY_ENTITLEMENTS,
		);
	});
});

describe("isManualGrantExpired", () => {
	const now = new Date("2026-07-13T00:00:00Z");
	const past = new Date("2026-07-01T00:00:00Z");
	const future = new Date("2026-08-01T00:00:00Z");

	it("lapses an off-Stripe grant whose term end has passed", () => {
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: null, paddleSubscriptionId: null, currentPeriodEnd: past },
				now,
			),
		).toBe(true);
	});

	it("keeps an off-Stripe grant whose term is still running", () => {
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: null, paddleSubscriptionId: null, currentPeriodEnd: future },
				now,
			),
		).toBe(false);
	});

	it("never lapses an open-ended grant (no term end)", () => {
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: null, paddleSubscriptionId: null, currentPeriodEnd: null },
				now,
			),
		).toBe(false);
	});

	it("never touches a Stripe-backed subscription, even past its period end", () => {
		// A paying customer's renewal date is the webhook's concern — a late renewal event
		// must not flicker them down to community. Only off-Stripe grants lapse here.
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: "sub_123", paddleSubscriptionId: null, currentPeriodEnd: past },
				now,
			),
		).toBe(false);
	});

	it("never touches a Paddle-backed subscription, even past its period end", () => {
		// The Paddle webhook maintains a Paddle subscriber's renewal date exactly as Stripe's does.
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: null, paddleSubscriptionId: "sub_01paddle", currentPeriodEnd: past },
				now,
			),
		).toBe(false);
	});

	it("lapses an expired provider-less trial grant", () => {
		// A card-less local trial has no provider object at all — its term end is the only thing
		// that ends it.
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: null, paddleSubscriptionId: null, currentPeriodEnd: past },
				now,
			),
		).toBe(true);
	});
});

describe("provider subscription helpers", () => {
	const none = {
		stripeSubscriptionId: null,
		paddleSubscriptionId: null,
		aiStripeSubscriptionId: null,
		aiPaddleSubscriptionId: null,
	};

	it("a row with no subscription id has no provider subscription in any slot", () => {
		expect(hasProviderSubscription(none)).toBe(false);
		expect(hasPlanSubscription(none)).toBe(false);
		expect(hasAiSubscription(none)).toBe(false);
	});

	it("any one of the four subscription id columns counts as a provider subscription", () => {
		for (const key of Object.keys(none)) {
			expect(hasProviderSubscription({ ...none, [key]: "sub_x" })).toBe(true);
		}
	});

	it("keeps the slots apart: an AI subscription does not make the plan provider-backed", () => {
		const aiOnly = { ...none, aiPaddleSubscriptionId: "sub_ai" };
		expect(hasPlanSubscription(aiOnly)).toBe(false);
		expect(hasAiSubscription(aiOnly)).toBe(true);
		// So an expired off-provider plan grant on that row still lapses.
		expect(
			isManualGrantExpired(
				{ ...aiOnly, currentPeriodEnd: new Date("2026-07-01T00:00:00Z") },
				new Date("2026-07-13T00:00:00Z"),
			),
		).toBe(true);
	});
});

describe("entitlementStatus (the Paddle past_due grace, O8)", () => {
	const start = new Date("2026-11-25T00:00:00Z");
	const row = { status: "past_due" as const, billingProvider: "paddle" as const, currentPeriodStart: start };

	it("reads a Paddle past_due row as active inside the 7-day grace", () => {
		expect(entitlementStatus(row, new Date(start.getTime() + PAST_DUE_GRACE_MS - 1))).toBe("active");
	});

	it("drops it once the grace is over", () => {
		expect(entitlementStatus(row, new Date(start.getTime() + PAST_DUE_GRACE_MS))).toBe("past_due");
	});

	it("gives no grace without a period start (fail closed)", () => {
		expect(entitlementStatus({ ...row, currentPeriodStart: null }, start)).toBe("past_due");
	});

	it("leaves Stripe rows exactly as they were: past_due grants nothing", () => {
		expect(entitlementStatus({ ...row, billingProvider: "stripe" }, start)).toBe("past_due");
		expect(entitlementStatus({ ...row, billingProvider: null }, start)).toBe("past_due");
	});

	it("passes every other status through", () => {
		for (const status of ["none", "trialing", "active", "canceled"] as const) {
			expect(entitlementStatus({ ...row, status }, start)).toBe(status);
		}
	});
});
