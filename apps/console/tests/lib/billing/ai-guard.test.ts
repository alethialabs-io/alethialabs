// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AI budget guard (lib/billing/ai-guard.ts). Mocked boundary: stub Stripe-configured, the
// resolved AI tier (INDEPENDENT of the org plan), credit-ledger sums + purchased balance,
// and the fixed per-kind cost; assert the self-host bypass, the not-enabled gate, and BOTH
// charge models: the FIXED (scan) reserve-up-front path (used+cost<=cap) and the METERED
// (agent/support) headroom→settle path (used<cap → { settle: true }), plus the per-seat
// sub-cap, the included→purchased fallback, and daily-vs-weekly exhaustion + resetAt.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: vi.fn() }));
vi.mock("@/lib/billing/ai-plan", () => ({
	resolveAiTier: vi.fn(),
	resolveAiPlan: vi.fn(),
	aiTierSpec: vi.fn(),
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	sumCredits: vi.fn(),
	sumCreditsForUser: vi.fn(),
	purchasedBalance: vi.fn(),
}));
vi.mock("@/lib/billing/ai-credits", () => ({ creditsFor: vi.fn(() => 5) }));

import { AiBudgetError, assertAiAllowed, isAiSurfaceEnabled } from "@/lib/billing/ai-guard";
import { aiTierSpec, resolveAiPlan, resolveAiTier } from "@/lib/billing/ai-plan";
import { creditsFor } from "@/lib/billing/ai-credits";
import { purchasedBalance, sumCredits, sumCreditsForUser } from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";

/**
 * A free-tier spec with small caps to keep the math legible: org daily 30 / weekly 100,
 * per-seat sub-cap daily 10 / weekly 40.
 */
const spec = (over: Record<string, unknown> = {}) => ({
	enabled: true,
	advisor: "none" as const,
	dailyCredits: 30,
	weeklyCredits: 100,
	perUserDailyCredits: 10,
	perUserWeeklyCredits: 40,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isStripeConfigured).mockReturnValue(true);
	vi.mocked(resolveAiTier).mockResolvedValue("ai_free");
	vi.mocked(resolveAiPlan).mockResolvedValue({ tier: "ai_free", hardCap: false });
	vi.mocked(aiTierSpec).mockReturnValue(spec());
	vi.mocked(creditsFor).mockReturnValue(5);
	vi.mocked(sumCreditsForUser).mockResolvedValue(0);
});

describe("isAiSurfaceEnabled", () => {
	it("is always enabled on self-host (no Stripe)", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		expect(await isAiSurfaceEnabled("org-1")).toBe(true);
	});

	it("reflects the tier's enabled flag when hosted", async () => {
		vi.mocked(aiTierSpec).mockReturnValue(spec({ enabled: false }));
		expect(await isAiSurfaceEnabled("org-1")).toBe(false);
	});
});

describe("assertAiAllowed", () => {
	it("bypasses with a zero charge on self-host", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		expect(await assertAiAllowed("org-1", "scan")).toEqual({
			source: "included",
			credits: 0,
		});
	});

	it("resolves the tier independently of the org plan (reads resolveAiPlan)", async () => {
		vi.mocked(sumCredits).mockResolvedValue(0);
		await assertAiAllowed("org-1", "scan");
		expect(resolveAiPlan).toHaveBeenCalledWith("org-1");
	});

	it("throws not_enabled when the tier has AI off", async () => {
		vi.mocked(aiTierSpec).mockReturnValue(spec({ enabled: false }));
		const err = await assertAiAllowed("org-1", "scan").catch((e) => e);
		expect(err).toBeInstanceOf(AiBudgetError);
		expect(err.reason).toBe("not_enabled");
	});

	it("charges included credits when within both the daily and weekly caps (free tier)", async () => {
		vi.mocked(sumCredits).mockResolvedValue(0); // both day + week used = 0
		expect(await assertAiAllowed("org-1", "scan")).toEqual({
			source: "included",
			credits: 5,
		});
	});

	it("falls back to purchased credits when the daily included cap is exhausted", async () => {
		vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(30); // day full
		vi.mocked(purchasedBalance).mockResolvedValue(10); // >= cost 5
		expect(await assertAiAllowed("org-1", "scan")).toEqual({
			source: "purchased",
			credits: 5,
		});
	});

	it("throws daily-exhausted (with a resetAt) when nothing is left", async () => {
		vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(30); // day full, week ok
		vi.mocked(purchasedBalance).mockResolvedValue(0);
		const err = await assertAiAllowed("org-1", "scan").catch((e) => e);
		expect(err.reason).toBe("daily");
		expect(err.resetAt).not.toBeNull();
	});

	it("throws weekly-exhausted when the weekly cap is the binding limit", async () => {
		vi.mocked(sumCredits).mockResolvedValueOnce(0).mockResolvedValueOnce(100); // week full
		vi.mocked(purchasedBalance).mockResolvedValue(0);
		const err = await assertAiAllowed("org-1", "scan").catch((e) => e);
		expect(err.reason).toBe("weekly");
	});

	it("does not read the per-user ledger when no userId is passed (back-compat)", async () => {
		vi.mocked(sumCredits).mockResolvedValue(0);
		await assertAiAllowed("org-1", "scan");
		expect(sumCreditsForUser).not.toHaveBeenCalled();
	});

	describe("metered (agent/support) headroom → settle", () => {
		it("returns an included settle charge when the org + seat have any headroom", async () => {
			vi.mocked(sumCredits).mockResolvedValue(0); // org empty
			vi.mocked(sumCreditsForUser).mockResolvedValue(0); // seat empty
			const charge = await assertAiAllowed("org-1", "agent", "user-1");
			expect(charge).toEqual({ source: "included", settle: true });
			// A metered turn never reserves the fixed per-kind cost up front.
			expect(creditsFor).not.toHaveBeenCalled();
		});

		it("still allows a turn when the bucket is nearly full (gate is headroom, not used+cost)", async () => {
			// day 29 < 30, week 99 < 100 — one turn may overshoot by ≤1 turn; it's allowed.
			vi.mocked(sumCredits).mockResolvedValueOnce(29).mockResolvedValueOnce(99);
			const charge = await assertAiAllowed("org-1", "agent");
			expect(charge).toEqual({ source: "included", settle: true });
		});

		it("402s the NEXT turn once the daily bucket is full (no headroom left)", async () => {
			// day exactly at the cap → no headroom; week still open; no packs.
			vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(50);
			vi.mocked(purchasedBalance).mockResolvedValue(0);
			const err = await assertAiAllowed("org-1", "agent").catch((e) => e);
			expect(err).toBeInstanceOf(AiBudgetError);
			expect(err.reason).toBe("daily");
			expect(err.upgradable).toBe(true);
		});

		it("settles against purchased packs when the org included headroom is gone (balance > 0)", async () => {
			vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(50); // day full
			vi.mocked(purchasedBalance).mockResolvedValue(1); // any positive balance suffices
			const charge = await assertAiAllowed("org-1", "agent");
			expect(charge).toEqual({ source: "purchased", settle: true });
		});

		it("blocks a seat at its personal cap while the org still has room (no purchased divert)", async () => {
			vi.mocked(sumCredits).mockResolvedValue(0); // org wide open
			vi.mocked(sumCreditsForUser)
				.mockResolvedValueOnce(10) // user day at cap (not < 10)
				.mockResolvedValueOnce(10); // user week ok
			vi.mocked(purchasedBalance).mockResolvedValue(100); // packs available — must NOT be used
			const err = await assertAiAllowed("org-1", "agent", "user-1").catch((e) => e);
			expect(err).toBeInstanceOf(AiBudgetError);
			expect(err.reason).toBe("daily");
			expect(err.upgradable).toBe(false);
			expect(purchasedBalance).not.toHaveBeenCalled();
		});
	});

	describe("per-user sub-caps", () => {
		it("charges included when the seat is within its personal caps (org has room too)", async () => {
			vi.mocked(sumCredits).mockResolvedValue(0); // org empty
			vi.mocked(sumCreditsForUser).mockResolvedValue(0); // seat empty
			expect(await assertAiAllowed("org-1", "scan", "user-1")).toEqual({
				source: "included",
				credits: 5,
			});
			expect(sumCreditsForUser).toHaveBeenCalledWith(
				"org-1",
				"user-1",
				"included",
				expect.any(Date),
			);
		});

		it("blocks a seat at its personal DAILY cap even though the org still has budget", async () => {
			vi.mocked(sumCredits).mockResolvedValue(0); // org wide open
			// seat used 10 (daily cap) already; weekly still under 40.
			vi.mocked(sumCreditsForUser)
				.mockResolvedValueOnce(10) // user day
				.mockResolvedValueOnce(10); // user week
			vi.mocked(purchasedBalance).mockResolvedValue(100); // packs available — must NOT be used
			const err = await assertAiAllowed("org-1", "scan", "user-1").catch((e) => e);
			expect(err).toBeInstanceOf(AiBudgetError);
			expect(err.reason).toBe("daily");
			expect(err.upgradable).toBe(false); // a per-seat cap isn't lifted by buying/upgrading
			expect(purchasedBalance).not.toHaveBeenCalled(); // did not divert to purchased
		});

		it("blocks a seat at its personal WEEKLY cap while the org still has budget", async () => {
			vi.mocked(sumCredits).mockResolvedValue(0); // org open
			vi.mocked(sumCreditsForUser)
				.mockResolvedValueOnce(0) // user day ok
				.mockResolvedValueOnce(40); // user week full
			const err = await assertAiAllowed("org-1", "scan", "user-1").catch((e) => e);
			expect(err.reason).toBe("weekly");
			expect(err.upgradable).toBe(false);
		});

		it("still hits the ORG cap first when the org is exhausted (personal cap not the binding limit)", async () => {
			vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(30); // org day full
			vi.mocked(sumCreditsForUser).mockResolvedValue(0); // seat fine
			vi.mocked(purchasedBalance).mockResolvedValue(10); // packs cover it
			expect(await assertAiAllowed("org-1", "scan", "user-1")).toEqual({
				source: "purchased",
				credits: 5,
			});
		});
	});

	describe("hard cap", () => {
		it("pauses at the included allowance (no purchased fallback) when usageHardCap is on", async () => {
			vi.mocked(resolveAiPlan).mockResolvedValue({ tier: "ai_free", hardCap: true });
			vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(30); // org day full
			vi.mocked(purchasedBalance).mockResolvedValue(1000); // packs available
			const err = await assertAiAllowed("org-1", "scan").catch((e) => e);
			expect(err).toBeInstanceOf(AiBudgetError);
			expect(err.reason).toBe("daily");
			expect(purchasedBalance).not.toHaveBeenCalled(); // hard cap → packs untouched
		});
	});
});
