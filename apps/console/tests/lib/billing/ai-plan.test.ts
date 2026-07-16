// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AI-tier ladder (lib/billing/ai-plan.ts). Asserts the standalone tier resolution is
// INDEPENDENT of the org plan, the free tier is always usable, and a lapsed paid AI
// subscription falls back to ai_free.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationBilling } from "@/lib/db/schema";

vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));

import {
	AI_SESSION_WINDOW_MS,
	AI_TIERS,
	aiTierSpec,
	effectiveAiTier,
	effectiveAiTierSpec,
	resolveAiPlan,
	resolveAiTier,
	SESSION_FRACTION_OF_WEEK,
} from "@/lib/billing/ai-plan";
import { getOrgBilling } from "@/lib/billing/queries";

beforeEach(() => vi.clearAllMocks());

describe("AI_TIERS ladder", () => {
	it("gives the free tier a usable session + weekly allowance", () => {
		expect(AI_TIERS.ai_free.enabled).toBe(true);
		expect(AI_TIERS.ai_free.sessionCredits).toBeGreaterThan(0);
		expect(AI_TIERS.ai_free.weeklyCredits).toBeGreaterThan(0);
		expect(AI_TIERS.ai_free.advisor).toBe("none");
	});

	it("raises the caps up the ladder with a Sonnet advisor on the paid tiers", () => {
		expect(AI_TIERS.ai_plus.sessionCredits).toBeGreaterThan(
			AI_TIERS.ai_free.sessionCredits,
		);
		expect(AI_TIERS.ai_max.sessionCredits).toBeGreaterThan(
			AI_TIERS.ai_plus.sessionCredits,
		);
		expect(AI_TIERS.ai_plus.weeklyCredits).toBeGreaterThan(AI_TIERS.ai_free.weeklyCredits);
		expect(AI_TIERS.ai_max.weeklyCredits).toBeGreaterThan(AI_TIERS.ai_plus.weeklyCredits);
		// Both paid tiers default to the Sonnet advisor; Max upgrades to Opus on demand
		// (per-message deep-reasoning opt-in — not a tier-static field).
		expect(AI_TIERS.ai_plus.advisor).toBe("sonnet");
		expect(AI_TIERS.ai_max.advisor).toBe("sonnet");
	});

	it("pins the recalibrated cost-of-serve allowances (weekly = the governor)", () => {
		expect(AI_TIERS.ai_free).toMatchObject({
			sessionCredits: 130,
			weeklyCredits: 510,
			perUserSessionCredits: 130,
			perUserWeeklyCredits: 510,
		});
		expect(AI_TIERS.ai_plus).toMatchObject({
			sessionCredits: 3_750,
			weeklyCredits: 15_000,
			perUserSessionCredits: 2_300,
			perUserWeeklyCredits: 9_200,
		});
		expect(AI_TIERS.ai_max).toMatchObject({
			sessionCredits: 18_750,
			weeklyCredits: 75_000,
			perUserSessionCredits: 11_500,
			perUserWeeklyCredits: 46_000,
		});
	});

	it("pins the 5-hour window and keeps the session cap at weekly ÷ 4 (rounded up)", () => {
		expect(AI_SESSION_WINDOW_MS).toBe(5 * 3_600_000);
		expect(SESSION_FRACTION_OF_WEEK).toBe(1 / 4);
		for (const tier of ["ai_free", "ai_plus", "ai_max"] as const) {
			const { sessionCredits, weeklyCredits } = AI_TIERS[tier];
			// weekly ÷ 4, rounded up to a clean figure (free: 127.5 → 130) — a saturated
			// day (~4.8 sessions) can exhaust the whole week; weekly stays the governor.
			expect(sessionCredits).toBeGreaterThanOrEqual(
				weeklyCredits * SESSION_FRACTION_OF_WEEK,
			);
			expect(sessionCredits).toBeLessThanOrEqual(
				Math.ceil(weeklyCredits * SESSION_FRACTION_OF_WEEK / 10) * 10,
			);
		}
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

describe("effectiveAiTierSpec (admin spend limits)", () => {
	const base = aiTierSpec("ai_plus"); // weekly 15000 / session 3750 / perUser 9200 / 2300

	it("is the tier spec unchanged when no admin caps are set", () => {
		expect(
			effectiveAiTierSpec(base, {
				orgWeeklyCapCredits: null,
				perUserWeeklyCapCredits: null,
			}),
		).toEqual(base);
	});

	it("tightens the org weekly + session caps when the org limit is below the tier", () => {
		const eff = effectiveAiTierSpec(base, {
			orgWeeklyCapCredits: 2_000,
			perUserWeeklyCapCredits: null,
		});
		expect(eff.weeklyCredits).toBe(2_000); // lowered to the admin ceiling
		expect(eff.sessionCredits).toBe(2_000); // session can't exceed the (now smaller) week
		// Per-seat caps can never exceed the org pool.
		expect(eff.perUserWeeklyCredits).toBeLessThanOrEqual(2_000);
		expect(eff.perUserSessionCredits).toBeLessThanOrEqual(2_000);
	});

	it("never RAISES a cap above the tier (a higher admin limit is a no-op)", () => {
		const eff = effectiveAiTierSpec(base, {
			orgWeeklyCapCredits: 999_999,
			perUserWeeklyCapCredits: 999_999,
		});
		expect(eff.weeklyCredits).toBe(base.weeklyCredits);
		expect(eff.perUserWeeklyCredits).toBe(base.perUserWeeklyCredits);
	});

	it("bounds a single seat with the per-user weekly limit", () => {
		const eff = effectiveAiTierSpec(base, {
			orgWeeklyCapCredits: null,
			perUserWeeklyCapCredits: 1_000,
		});
		expect(eff.perUserWeeklyCredits).toBe(1_000);
		expect(eff.perUserSessionCredits).toBeLessThanOrEqual(1_000);
		// The org pool is untouched.
		expect(eff.weeklyCredits).toBe(base.weeklyCredits);
	});
});

describe("resolveAiPlan (admin caps)", () => {
	it("reads the admin spend limits off the billing row", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({
			aiTier: "ai_plus",
			aiSubscriptionStatus: "active",
			usageHardCap: false,
			aiOrgWeeklyCapCredits: 5_000,
			aiPerUserWeeklyCapCredits: 1_200,
		} as OrganizationBilling);
		const plan = await resolveAiPlan("org-1");
		expect(plan).toMatchObject({
			tier: "ai_plus",
			orgWeeklyCapCredits: 5_000,
			perUserWeeklyCapCredits: 1_200,
		});
	});

	it("has no admin caps with no billing row", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		const plan = await resolveAiPlan("org-1");
		expect(plan.orgWeeklyCapCredits).toBeNull();
		expect(plan.perUserWeeklyCapCredits).toBeNull();
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
