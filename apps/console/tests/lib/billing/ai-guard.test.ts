// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AI budget guard (lib/billing/ai-guard.ts). Mocked boundary: stub Stripe-configured, the
// resolved AI tier (INDEPENDENT of the org plan), credit-ledger sums + purchased balance,
// and per-kind cost; assert the self-host bypass, the not-enabled gate, the free-tier
// allowance, the included→purchased fallback, and the daily-vs-weekly exhaustion + resetAt.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: vi.fn() }));
vi.mock("@/lib/billing/ai-plan", () => ({
	resolveAiTier: vi.fn(),
	aiTierSpec: vi.fn(),
}));
vi.mock("@/lib/billing/ai-quota", () => ({ sumCredits: vi.fn(), purchasedBalance: vi.fn() }));
vi.mock("@/lib/billing/ai-credits", () => ({ creditsFor: vi.fn(() => 5) }));

import { AiBudgetError, assertAiAllowed, isAiSurfaceEnabled } from "@/lib/billing/ai-guard";
import { aiTierSpec, resolveAiTier } from "@/lib/billing/ai-plan";
import { creditsFor } from "@/lib/billing/ai-credits";
import { purchasedBalance, sumCredits } from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";

/** A free-tier spec with small caps to keep the math legible (daily 30, weekly 100). */
const spec = (over: Record<string, unknown> = {}) => ({
	enabled: true,
	advisor: "none" as const,
	dailyCredits: 30,
	weeklyCredits: 100,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isStripeConfigured).mockReturnValue(true);
	vi.mocked(resolveAiTier).mockResolvedValue("ai_free");
	vi.mocked(aiTierSpec).mockReturnValue(spec());
	vi.mocked(creditsFor).mockReturnValue(5);
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

	it("resolves the tier independently of the org plan (reads resolveAiTier)", async () => {
		vi.mocked(sumCredits).mockResolvedValue(0);
		await assertAiAllowed("org-1", "scan");
		expect(resolveAiTier).toHaveBeenCalledWith("org-1");
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
});
