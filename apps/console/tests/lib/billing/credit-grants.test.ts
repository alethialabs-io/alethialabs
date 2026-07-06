// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Included-credit Stripe grant (lib/billing/credit-grants.ts). Mocked boundary: stub Stripe +
// plan lookups; assert every no-op guard, the period idempotency, the monetary amount math
// (usd → cents), the metered scope, and the best-effort swallow.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: vi.fn(), planForPriceId: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@repo/plan-catalog", () => ({ planMeta: vi.fn() }));

import { ensureIncludedCredit } from "@/lib/billing/credit-grants";
import { isStripeConfigured, planForPriceId } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { planMeta } from "@repo/plan-catalog";

function stripeWith(existing: Array<{ metadata?: Record<string, string> }> = []) {
	const list = vi.fn(async () => ({ data: existing }));
	const create = vi.fn(async () => ({}));
	vi.mocked(getStripe).mockReturnValue({ billing: { creditGrants: { list, create } } } as never);
	return { list, create };
}

function sub(over: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
	return {
		status: "active",
		metadata: { organization_id: "org-1" },
		items: {
			data: [{ price: { id: "price_team" }, current_period_end: 2000, current_period_start: 1000 }],
		},
		customer: "cus_1",
		...over,
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isStripeConfigured).mockReturnValue(true);
	vi.mocked(planForPriceId).mockReturnValue("team" as never);
	vi.mocked(planMeta).mockReturnValue({ name: "Team", includedCreditUsd: 25 } as never);
});

describe("ensureIncludedCredit — happy path", () => {
	it("grants the plan's included credit scoped to metered usage, in cents", async () => {
		const { create } = stripeWith([]);
		await ensureIncludedCredit(sub());
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				customer: "cus_1",
				amount: { type: "monetary", monetary: { currency: "usd", value: 2500 } }, // 25 × 100
				applicability_config: { scope: { price_type: "metered" } },
				expires_at: 2000,
				metadata: { period: "1000", organization_id: "org-1" },
			}),
		);
	});

	it("resolves the customer id from a customer object", async () => {
		const { create } = stripeWith([]);
		await ensureIncludedCredit(sub({ customer: { id: "cus_obj" } as never }));
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_obj" }));
	});
});

describe("ensureIncludedCredit — no-op guards", () => {
	it("skips when Stripe isn't configured", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		const { create } = stripeWith([]);
		await ensureIncludedCredit(sub());
		expect(create).not.toHaveBeenCalled();
	});

	it("skips a non-active subscription", async () => {
		const { create } = stripeWith([]);
		await ensureIncludedCredit(sub({ status: "trialing" as never }));
		expect(create).not.toHaveBeenCalled();
	});

	it("skips when no organization_id is on the subscription", async () => {
		const { create } = stripeWith([]);
		await ensureIncludedCredit(sub({ metadata: {} as never }));
		expect(create).not.toHaveBeenCalled();
	});

	it("skips when the price maps to no plan", async () => {
		vi.mocked(planForPriceId).mockReturnValue(null as never);
		const { create } = stripeWith([]);
		await ensureIncludedCredit(sub());
		expect(create).not.toHaveBeenCalled();
	});

	it("skips when the plan has no included credit", async () => {
		vi.mocked(planMeta).mockReturnValue({ name: "Hobby", includedCreditUsd: 0 } as never);
		const { create } = stripeWith([]);
		await ensureIncludedCredit(sub());
		expect(create).not.toHaveBeenCalled();
	});
});

describe("ensureIncludedCredit — idempotency + resilience", () => {
	it("does not double-grant when this period's grant already exists", async () => {
		const { create } = stripeWith([
			{ metadata: { period: "1000", organization_id: "org-1" } },
		]);
		await ensureIncludedCredit(sub());
		expect(create).not.toHaveBeenCalled();
	});

	it("still grants when only a DIFFERENT period's grant exists", async () => {
		const { create } = stripeWith([
			{ metadata: { period: "999", organization_id: "org-1" } },
		]);
		await ensureIncludedCredit(sub());
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("swallows a Stripe error (best-effort, never throws)", async () => {
		const list = vi.fn(async () => ({ data: [] }));
		const create = vi.fn(async () => {
			throw new Error("stripe down");
		});
		vi.mocked(getStripe).mockReturnValue({ billing: { creditGrants: { list, create } } } as never);
		await expect(ensureIncludedCredit(sub())).resolves.toBeUndefined();
	});
});
