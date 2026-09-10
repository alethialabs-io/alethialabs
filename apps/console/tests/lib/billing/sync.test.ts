// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

// mapStatus / planFromSubscription are pure, but sync.ts pulls in the DB/Stripe write path
// at import time — stub those so the unit test stays I/O-free (their behavior is covered by
// integration tests).
vi.mock("@/lib/billing/credit-grants", () => ({ ensureIncludedCredit: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({ upsertOrgBilling: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({
	planForPriceId: vi.fn(),
	aiTierForPriceId: vi.fn(),
}));

import { mapStatus, planFromSubscription, planItem } from "@/lib/billing/sync";
import { planForPriceId } from "@/lib/billing/config";

/** A subscription carrying only the fields planFromSubscription reads. */
function subWithPlan(plan?: string): Stripe.Subscription {
	return { metadata: plan ? { plan } : {} } as unknown as Stripe.Subscription;
}

/** One subscription item, carrying only the fields `planItem` reads. */
function item(
	id: string,
	priceId: string,
	usageType: "licensed" | "metered" | null,
): Stripe.SubscriptionItem {
	return {
		id,
		price: { id: priceId, recurring: usageType ? { usage_type: usageType } : null },
	} as unknown as Stripe.SubscriptionItem;
}

/** A subscription over the given items, in the given order. */
function subWithItems(...items: Stripe.SubscriptionItem[]): Stripe.Subscription {
	return { items: { data: items } } as unknown as Stripe.Subscription;
}

describe("mapStatus", () => {
	it("maps live statuses through unchanged", () => {
		expect(mapStatus("active")).toBe("active");
		expect(mapStatus("trialing")).toBe("trialing");
	});

	it("collapses dunning statuses to past_due", () => {
		expect(mapStatus("past_due")).toBe("past_due");
		expect(mapStatus("unpaid")).toBe("past_due");
	});

	it("collapses terminal statuses to canceled", () => {
		expect(mapStatus("canceled")).toBe("canceled");
		expect(mapStatus("incomplete_expired")).toBe("canceled");
	});

	it("treats any other status as none", () => {
		expect(mapStatus("incomplete")).toBe("none");
		expect(mapStatus("paused")).toBe("none");
	});
});

describe("planItem", () => {
	const flat = item("si_flat", "price_team", "licensed");
	const meter = item("si_meter", "price_meter_team", "metered");

	// THE ORDER IS THE TEST. Stripe does not promise `items.data` in creation order, and reading
	// position 0 was correct only for as long as it happened to come back flat-first: with the
	// meter at position 0, `planForPriceId` returns null and syncSubscriptionToBilling stamps
	// `community` over a live Pro subscription. Both orders must give the same answer, so a
	// re-introduced `items.data[0]` fails one of these two cases rather than neither.
	it("picks the licensed line when the meter is listed FIRST", () => {
		expect(planItem(subWithItems(meter, flat))?.id).toBe("si_flat");
	});

	it("picks the licensed line when the meter is listed SECOND", () => {
		expect(planItem(subWithItems(flat, meter))?.id).toBe("si_flat");
	});

	it("returns the only item of a single-item (no meter configured) subscription", () => {
		expect(planItem(subWithItems(flat))?.id).toBe("si_flat");
	});

	it("treats a price with no recurring component as the plan line", () => {
		// `usage_type` lives on `price.recurring`; an absent one must not read as metered, which is
		// the same reading getBillingSummary and syncOrgSeats take.
		expect(planItem(subWithItems(item("si_odd", "price_odd", null)))?.id).toBe("si_odd");
	});

	it("returns undefined rather than a meter when every line is metered", () => {
		// Fail closed: the caller then resolves the plan from metadata.plan alone. Answering with
		// the meter is the defect this function exists to prevent.
		expect(planItem(subWithItems(meter))).toBeUndefined();
	});

	it("returns undefined for a subscription with no items", () => {
		expect(planItem(subWithItems())).toBeUndefined();
	});
});

describe("planFromSubscription", () => {
	it("trusts a valid metadata.plan even when the price id maps to nothing", () => {
		// Enterprise is sold on a custom negotiated price, so planForPriceId can't recover it.
		// Without metadata.plan the org would be silently written back to community.
		vi.mocked(planForPriceId).mockReturnValue(null);
		expect(planFromSubscription(subWithPlan("enterprise"), "price_custom")).toBe(
			"enterprise",
		);
		expect(planForPriceId).not.toHaveBeenCalled();
	});

	it("ignores a malformed metadata.plan and falls back to the price id", () => {
		vi.mocked(planForPriceId).mockReturnValue("team");
		expect(planFromSubscription(subWithPlan("owner"), "price_team")).toBe("team");
		expect(planForPriceId).toHaveBeenCalledWith("price_team");
	});

	it("falls back to the price id when there is no metadata.plan (self-serve Team)", () => {
		vi.mocked(planForPriceId).mockReturnValue("team");
		expect(planFromSubscription(subWithPlan(), "price_team")).toBe("team");
	});

	it("returns null when neither metadata nor a resolvable price id is present", () => {
		vi.mocked(planForPriceId).mockReturnValue(null);
		expect(planFromSubscription(subWithPlan(), undefined)).toBeNull();
	});
});
