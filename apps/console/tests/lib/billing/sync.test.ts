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

import { mapStatus, planFromSubscription } from "@/lib/billing/sync";
import { planForPriceId } from "@/lib/billing/config";

/** A subscription carrying only the fields planFromSubscription reads. */
function subWithPlan(plan?: string): Stripe.Subscription {
	return { metadata: plan ? { plan } : {} } as unknown as Stripe.Subscription;
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
