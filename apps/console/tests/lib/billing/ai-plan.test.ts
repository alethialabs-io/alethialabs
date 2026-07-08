// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AI-tier ladder (lib/billing/ai-plan.ts). Asserts the standalone tier resolution is
// INDEPENDENT of the org plan, the free tier is always usable, and a lapsed paid AI
// subscription falls back to ai_free.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationBilling } from "@/lib/db/schema";

vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));

import { AI_TIERS, effectiveAiTier, resolveAiTier } from "@/lib/billing/ai-plan";
import { getOrgBilling } from "@/lib/billing/queries";

beforeEach(() => vi.clearAllMocks());

describe("AI_TIERS ladder", () => {
	it("gives the free tier a usable daily + weekly allowance", () => {
		expect(AI_TIERS.ai_free.enabled).toBe(true);
		expect(AI_TIERS.ai_free.dailyCredits).toBeGreaterThan(0);
		expect(AI_TIERS.ai_free.weeklyCredits).toBeGreaterThan(0);
		expect(AI_TIERS.ai_free.advisor).toBe("none");
	});

	it("raises the caps and upgrades the advisor up the ladder", () => {
		expect(AI_TIERS.ai_plus.dailyCredits).toBeGreaterThan(AI_TIERS.ai_free.dailyCredits);
		expect(AI_TIERS.ai_max.dailyCredits).toBeGreaterThan(AI_TIERS.ai_plus.dailyCredits);
		expect(AI_TIERS.ai_plus.advisor).toBe("sonnet");
		expect(AI_TIERS.ai_max.advisor).toBe("opus");
	});
});

describe("effectiveAiTier", () => {
	it("keeps a paid tier only while its subscription is live", () => {
		expect(effectiveAiTier("ai_plus", "active")).toBe("ai_plus");
		expect(effectiveAiTier("ai_max", "trialing")).toBe("ai_max");
	});

	it("lapses a paid tier back to ai_free when not live", () => {
		expect(effectiveAiTier("ai_plus", "canceled")).toBe("ai_free");
		expect(effectiveAiTier("ai_max", "past_due")).toBe("ai_free");
		expect(effectiveAiTier("ai_plus", "none")).toBe("ai_free");
	});

	it("ai_free is inert regardless of status", () => {
		expect(effectiveAiTier("ai_free", "active")).toBe("ai_free");
	});
});

describe("resolveAiTier", () => {
	it("defaults to ai_free with no billing row (independent of org plan)", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		expect(await resolveAiTier("org-1")).toBe("ai_free");
	});

	it("returns the paid tier for a live AI subscription, ignoring the org plan", async () => {
		// A community-plan org with a live AI Plus subscription → ai_plus.
		vi.mocked(getOrgBilling).mockResolvedValue({
			plan: "community",
			status: "none",
			aiTier: "ai_plus",
			aiSubscriptionStatus: "active",
		} as OrganizationBilling);
		expect(await resolveAiTier("org-1")).toBe("ai_plus");
	});

	it("falls back to ai_free when the paid AI subscription lapsed", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			aiTier: "ai_max",
			aiSubscriptionStatus: "canceled",
		} as OrganizationBilling);
		expect(await resolveAiTier("org-1")).toBe("ai_free");
	});
});
