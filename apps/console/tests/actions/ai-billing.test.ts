// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary test for getAiUsage: stub the actor + ledger reads, keep the AI-tier
// math real, and assert the proportions/tier the AI usage surface shows. AI is now a
// STANDALONE tier (ai-plan.ts), independent of the org plan.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationBilling } from "@/lib/db/schema";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({
	sumCredits: vi.fn(),
	purchasedBalance: vi.fn(),
}));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));

import { getAiUsage } from "@/app/server/actions/ai-billing";
import { currentActor } from "@/lib/authz/guard";
import { AI_TIERS } from "@/lib/billing/ai-plan";
import { purchasedBalance, sumCredits } from "@/lib/billing/ai-quota";
import { getOrgBilling } from "@/lib/billing/queries";

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
	vi.mocked(purchasedBalance).mockResolvedValue(0);
});
afterEach(() => {
	if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
	else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe("getAiUsage", () => {
	it("defaults to the free AI tier when the org has no billing", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		vi.mocked(sumCredits).mockResolvedValue(0);

		const r = await getAiUsage();
		expect(r.tier).toBe("ai_free");
		expect(r.enabled).toBe(true);
		expect(r.dailyPctUsed).toBe(0);
		expect(r.weeklyPctUsed).toBe(0);
	});

	it("computes daily/weekly proportions off the tier caps and caps at 100", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			aiTier: "ai_plus",
			aiSubscriptionStatus: "active",
		} as OrganizationBilling);
		const plus = AI_TIERS.ai_plus; // daily 200, weekly 1500
		// Return more than the daily cap → capped at 100; weekly is a partial fraction.
		vi.mocked(sumCredits).mockResolvedValue(plus.dailyCredits * 2);
		vi.mocked(purchasedBalance).mockResolvedValue(250);

		const r = await getAiUsage();
		expect(r.tier).toBe("ai_plus");
		expect(r.dailyPctUsed).toBe(100); // 400/200 → capped
		expect(r.weeklyPctUsed).toBe(
			Math.round(((plus.dailyCredits * 2) / plus.weeklyCredits) * 100),
		);
		expect(r.purchasedBalance).toBe(250);
		// Reset timestamps are valid ISO strings in the future.
		expect(new Date(r.dailyResetAt).getTime()).toBeGreaterThan(Date.now());
		expect(new Date(r.weeklyResetAt).getTime()).toBeGreaterThan(Date.now());
	});

	it("falls back to ai_free when a paid AI subscription is not live", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			aiTier: "ai_max",
			aiSubscriptionStatus: "canceled",
		} as OrganizationBilling);
		vi.mocked(sumCredits).mockResolvedValue(0);

		expect((await getAiUsage()).tier).toBe("ai_free");
	});

	it("reflects whether hosted billing is configured", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		vi.mocked(sumCredits).mockResolvedValue(0);
		process.env.STRIPE_SECRET_KEY = "sk_test_123";
		expect((await getAiUsage()).hosted).toBe(true);
	});
});
