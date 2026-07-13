// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	COMMUNITY_ENTITLEMENTS,
	isBillingActive,
	isManualGrantExpired,
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
				{ stripeSubscriptionId: null, currentPeriodEnd: past },
				now,
			),
		).toBe(true);
	});

	it("keeps an off-Stripe grant whose term is still running", () => {
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: null, currentPeriodEnd: future },
				now,
			),
		).toBe(false);
	});

	it("never lapses an open-ended grant (no term end)", () => {
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: null, currentPeriodEnd: null },
				now,
			),
		).toBe(false);
	});

	it("never touches a Stripe-backed subscription, even past its period end", () => {
		// A paying customer's renewal date is the webhook's concern — a late renewal event
		// must not flicker them down to community. Only off-Stripe grants lapse here.
		expect(
			isManualGrantExpired(
				{ stripeSubscriptionId: "sub_123", currentPeriodEnd: past },
				now,
			),
		).toBe(false);
	});
});
