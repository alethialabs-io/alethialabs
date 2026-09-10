// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mapStatus / planFromSubscription are pure, but sync.ts pulls in the DB/Stripe write path
// at import time — stub those so the unit test stays I/O-free (their behavior is covered by
// integration tests). `isBillingActive` and `effectiveAiTier` are left REAL: they are pure, and
// stubbing the predicate a test is about would let the wrong answer pass.
vi.mock("@/lib/billing/credit-grants", () => ({ ensureIncludedCredit: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({
	upsertOrgBilling: vi.fn(),
	upsertOrgAiSubscription: vi.fn(),
	claimPlanWelcome: vi.fn(async () => false),
}));
vi.mock("@/lib/email/billing-email", () => ({ sendPlanWelcomeEmail: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({
	planForPriceId: vi.fn(),
	aiTierForPriceId: vi.fn(),
}));

import {
	mapStatus,
	planFromSubscription,
	planItem,
	syncSubscriptionToBilling,
} from "@/lib/billing/sync";
import { aiTierForPriceId, planForPriceId } from "@/lib/billing/config";
import { upsertOrgAiSubscription, upsertOrgBilling } from "@/lib/billing/queries";

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

// ── syncSubscriptionToBilling ─────────────────────────────────────────────────────────────
//
// THE POINT OF DRIVING THE WHOLE FUNCTION, rather than only `planItem`: the regression this
// guards is not "the wrong item was selected", it is "the wrong PLAN was written". Three fields
// come off that one item — the price the plan is derived from, `seats`, and `currentPeriodEnd` —
// so an assertion on the selector alone would still pass if a later edit read position 0 for the
// other two. What is asserted here is the row.
describe("syncSubscriptionToBilling", () => {
	const flat = {
		id: "si_flat",
		price: { id: "price_team", recurring: { usage_type: "licensed" } },
		quantity: 4,
		current_period_end: 1_800_000_000,
	} as unknown as Stripe.SubscriptionItem;
	const meter = {
		id: "si_meter",
		price: { id: "price_meter_team", recurring: { usage_type: "metered" } },
		current_period_end: 1_800_000_000,
	} as unknown as Stripe.SubscriptionItem;

	/** A live subscription for `org_1`, over the items given IN THE ORDER GIVEN. */
	function sub(
		items: Stripe.SubscriptionItem[],
		over: Partial<Stripe.Subscription> = {},
	): Stripe.Subscription {
		return {
			id: "sub_1",
			status: "trialing",
			customer: "cus_1",
			metadata: { organization_id: "org_1" },
			items: { data: items },
			...over,
		} as unknown as Stripe.Subscription;
	}

	beforeEach(() => {
		vi.mocked(planForPriceId).mockImplementation((id) => (id === "price_team" ? "team" : null));
		vi.mocked(aiTierForPriceId).mockReturnValue(null);
	});
	afterEach(() => {
		vi.mocked(upsertOrgBilling).mockClear();
		vi.mocked(upsertOrgAiSubscription).mockClear();
	});

	// THE REGRESSION, stated as the row it would have written. With the meter first, the old
	// `items.data[0]` handed `planForPriceId` the METER price, which resolves to null, and
	// `plan: live && plan ? plan : "community"` wrote `community` over a live Pro subscription.
	it("writes the plan off the licensed item even when the meter is listed FIRST", async () => {
		await syncSubscriptionToBilling(sub([meter, flat]));
		expect(upsertOrgBilling).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org_1",
				plan: "team",
				status: "trialing",
				seats: 4,
				currentPeriodEnd: new Date(1_800_000_000 * 1000),
			}),
		);
	});

	it("writes the same row when the meter is listed SECOND", async () => {
		await syncSubscriptionToBilling(sub([flat, meter]));
		expect(upsertOrgBilling).toHaveBeenCalledWith(
			expect.objectContaining({ plan: "team", seats: 4 }),
		);
	});

	it("keeps a non-live subscription on community, with no renewal date", async () => {
		// An `incomplete` upgrade must not light up Pro in the billing panel; the subscription id
		// is still retained so the panel can clean it up.
		await syncSubscriptionToBilling(sub([flat], { status: "incomplete" }));
		expect(upsertOrgBilling).toHaveBeenCalledWith(
			expect.objectContaining({
				plan: "community",
				status: "none",
				stripeSubscriptionId: "sub_1",
				currentPeriodEnd: null,
			}),
		);
	});

	it("falls back to metadata.plan, and warns, when every line is metered", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await syncSubscriptionToBilling(
			sub([meter], { metadata: { organization_id: "org_1", plan: "enterprise" } }),
		);
		expect(upsertOrgBilling).toHaveBeenCalledWith(
			// No plan line, so no seats and no period either — every one of them came off that item.
			expect.objectContaining({ plan: "enterprise", seats: null, currentPeriodEnd: null }),
		);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("none is a licensed plan line"));
		warn.mockRestore();
	});

	it("routes a standalone AI subscription to the AI columns and leaves the plan alone", async () => {
		vi.mocked(aiTierForPriceId).mockReturnValue("ai_plus");
		await syncSubscriptionToBilling(
			sub([
				{
					id: "si_ai",
					price: { id: "price_ai_plus", recurring: { usage_type: "licensed" } },
				} as unknown as Stripe.SubscriptionItem,
			]),
		);
		expect(upsertOrgAiSubscription).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org_1",
				aiTier: "ai_plus",
				aiSubscriptionStatus: "trialing",
				aiStripeSubscriptionId: "sub_1",
			}),
		);
		expect(upsertOrgBilling).not.toHaveBeenCalled();
	});

	it("ignores a subscription with no organization_id rather than guessing a tenant", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await syncSubscriptionToBilling(sub([flat], { metadata: {} }));
		expect(upsertOrgBilling).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("no organization_id"));
		warn.mockRestore();
	});

	it("resolves an expanded customer object to its id", async () => {
		await syncSubscriptionToBilling(
			sub([flat], { customer: { id: "cus_expanded" } as Stripe.Customer }),
		);
		expect(upsertOrgBilling).toHaveBeenCalledWith(
			expect.objectContaining({ stripeCustomerId: "cus_expanded" }),
		);
	});
});
