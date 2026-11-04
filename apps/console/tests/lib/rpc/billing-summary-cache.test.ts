// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6127: the Stripe subscription read behind `billing.summary` is cached (process-local, 45 s) and
// coalesced. Every member's Usage and Billing page reads the summary, and every `billing` hint
// refetches it — uncached, that is Stripe calls × visible tabs × webhook burst against one rate
// limit. A change Stripe announced (the webhook moves the event watermark) is a MISS, and this
// app's own writes drop the entry, so neither ever reads a stale plan back.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { retrieve, billingRow } = vi.hoisted(() => ({
	retrieve: vi.fn(),
	billingRow: {
		plan: "team" as const,
		status: "active" as const,
		stripeCustomerId: "cus_1",
		stripeSubscriptionId: "sub_1",
		stripeSubscriptionEventAt: new Date("2026-10-01T00:00:00Z") as Date | null,
		seats: 3,
		currentPeriodEnd: null,
	},
}));

vi.mock("@/lib/authz/guard", () => ({
	currentActor: async () => ({ userId: "user-1", orgId: "org-1" }),
	authorizeQuiet: async () => ({ userId: "user-1", orgId: "org-1" }),
	authorizeRead: async () => ({ userId: "user-1", orgId: "org-1" }),
}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => true }));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: async () => ({ ...billingRow }) }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => ({ subscriptions: { retrieve } }) }));
vi.mock("@/lib/billing/sync", () => ({ mapStatus: (s: string) => s }));
vi.mock("@/lib/billing/pricing", () => ({
	getAllAiPrices: vi.fn(),
	getPlanPrice: async () => ({ currency: "usd", amounts: {} }),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: async () => [{ n: 3 }] }) }),
	}),
}));

import { forgetSubscription, SUBSCRIPTION_CACHE_TTL_MS } from "@/lib/billing/subscription-cache";
import { getBillingSummary } from "@/lib/rpc/procedures/billing";

/** A live subscription with one flat price. */
function subscription(cancelAtPeriodEnd: boolean) {
	return {
		status: "active",
		cancel_at_period_end: cancelAtPeriodEnd,
		items: {
			data: [
				{
					price: { unit_amount: 2000, currency: "usd", recurring: { usage_type: "licensed" } },
					current_period_end: 1_800_000_000,
				},
			],
		},
	};
}

let eventSeconds = 0;

beforeEach(() => {
	retrieve.mockReset();
	retrieve.mockResolvedValue(subscription(false));
	// A fresh watermark per test: the cache is module state, and each test starts from a miss.
	eventSeconds += 60;
	billingRow.stripeSubscriptionEventAt = new Date(Date.UTC(2026, 9, 1, 0, 0, eventSeconds));
	vi.useRealTimers();
});

describe("billing.summary's subscription read", () => {
	it("serves many summaries inside the window from ONE Stripe read, concurrent ones included", async () => {
		await Promise.all([getBillingSummary(), getBillingSummary(), getBillingSummary()]);
		await getBillingSummary();
		expect(retrieve).toHaveBeenCalledTimes(1);
	});

	it("reads Stripe again once the window has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		await getBillingSummary();
		vi.setSystemTime(Date.now() + SUBSCRIPTION_CACHE_TTL_MS + 1);
		await getBillingSummary();
		expect(retrieve).toHaveBeenCalledTimes(2);
	});

	it("a Stripe event the webhook applied (the watermark moved) is a miss, not a stale plan", async () => {
		expect((await getBillingSummary()).state).toBe("active");
		retrieve.mockResolvedValue(subscription(true));
		billingRow.stripeSubscriptionEventAt = new Date((billingRow.stripeSubscriptionEventAt?.getTime() ?? 0) + 1000);
		expect((await getBillingSummary()).state).toBe("canceling");
	});

	it("this app's own write drops the entry, so the page reads its change back", async () => {
		await getBillingSummary();
		retrieve.mockResolvedValue(subscription(true));
		forgetSubscription("sub_1");
		expect((await getBillingSummary()).state).toBe("canceling");
		expect(retrieve).toHaveBeenCalledTimes(2);
	});

	it("a failed read is not cached", async () => {
		retrieve.mockRejectedValueOnce(new Error("stripe down"));
		await getBillingSummary(); // falls back to the DB row; the failure is not remembered
		await getBillingSummary();
		expect(retrieve).toHaveBeenCalledTimes(2);
	});
});
