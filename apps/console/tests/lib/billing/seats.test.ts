// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-seat billing reconciliation (lib/billing/seats.ts). Mocked boundary: stub Stripe + the org
// billing row + a thenable drizzle chain; assert the seat math, the live-subscription guards, and
// that we only ever touch the flat (non-metered) line and skip a no-op Stripe write.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { countBillableSeats, syncOrgSeats } from "@/lib/billing/seats";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";

/** drizzle-ish chain resolving the seat-count select to `rows`. */
function mockSeatCount(n: number | null) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		then: (resolve: (v: unknown) => void) => resolve(n === null ? [] : [{ n }]),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

/** A Stripe double with one flat + one metered line item. */
function stripeWith(flatQuantity: number) {
	const update = vi.fn(async () => ({}));
	const retrieve = vi.fn(async () => ({
		id: "sub_1",
		items: {
			data: [
				{ id: "si_metered", quantity: 99, price: { recurring: { usage_type: "metered" } } },
				{ id: "si_flat", quantity: flatQuantity, price: { recurring: { usage_type: "licensed" } } },
			],
		},
	}));
	vi.mocked(getStripe).mockReturnValue({ subscriptions: { retrieve, update } } as never);
	return { update, retrieve };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isStripeConfigured).mockReturnValue(true);
});

describe("countBillableSeats", () => {
	it("returns the counted seats, or 0 when none", async () => {
		mockSeatCount(3);
		expect(await countBillableSeats("org-1")).toBe(3);
		mockSeatCount(null);
		expect(await countBillableSeats("org-1")).toBe(0);
	});
});

describe("syncOrgSeats — guards (no Stripe write)", () => {
	it("no-ops when Stripe is not configured", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		await syncOrgSeats("org-1");
		expect(getOrgBilling).not.toHaveBeenCalled();
	});

	it("no-ops without a subscription id", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({ stripeSubscriptionId: null } as never);
		const { retrieve } = stripeWith(1);
		await syncOrgSeats("org-1");
		expect(retrieve).not.toHaveBeenCalled();
	});

	it("no-ops when the subscription isn't live (active/trialing)", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			stripeSubscriptionId: "sub_1",
			status: "canceled",
		} as never);
		const { retrieve } = stripeWith(1);
		await syncOrgSeats("org-1");
		expect(retrieve).not.toHaveBeenCalled();
	});

	it("skips the write when the flat quantity already matches", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			stripeSubscriptionId: "sub_1",
			status: "active",
		} as never);
		mockSeatCount(3);
		const { update } = stripeWith(3); // already 3
		await syncOrgSeats("org-1");
		expect(update).not.toHaveBeenCalled();
	});
});

describe("syncOrgSeats — reconcile", () => {
	it("updates ONLY the flat item quantity (prorated) when it differs", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			stripeSubscriptionId: "sub_1",
			status: "active",
		} as never);
		mockSeatCount(2);
		const { update } = stripeWith(1); // 1 → 2
		await syncOrgSeats("org-1");
		expect(update).toHaveBeenCalledWith("sub_1", {
			items: [{ id: "si_flat", quantity: 2 }],
			proration_behavior: "create_prorations",
		});
	});

	it("floors the quantity at 1 even when zero billable seats remain", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			stripeSubscriptionId: "sub_1",
			status: "trialing",
		} as never);
		mockSeatCount(0);
		const { update } = stripeWith(5); // 5 → max(1,0)=1
		await syncOrgSeats("org-1");
		expect(update).toHaveBeenCalledWith("sub_1", {
			items: [{ id: "si_flat", quantity: 1 }],
			proration_behavior: "create_prorations",
		});
	});
});
