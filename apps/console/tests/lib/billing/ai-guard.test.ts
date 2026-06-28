// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AI budget guard (lib/billing/ai-guard.ts). Mocked boundary: stub Stripe-configured, entitlements,
// credit ledger sums + purchased balance, and per-kind cost; assert the self-host bypass, the
// not-enabled gate, included→purchased fallback, and the window-vs-weekly exhaustion + resetAt.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));
vi.mock("@/lib/billing/plan", () => ({ resolvePlanEntitlements: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ sumCredits: vi.fn(), purchasedBalance: vi.fn() }));
vi.mock("@/lib/billing/ai-credits", () => ({ creditsFor: vi.fn(() => 5) }));

import { AiBudgetError, assertAiAllowed, isAiSurfaceEnabled } from "@/lib/billing/ai-guard";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { purchasedBalance, sumCredits } from "@/lib/billing/ai-quota";

const aiEntitlement = (over: Record<string, unknown> = {}) => ({
	ai: { enabled: true, windowHours: 5, windowCredits: 30, weeklyCredits: 100, ...over },
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isStripeConfigured).mockReturnValue(true);
	vi.mocked(getOrgBilling).mockResolvedValue({ plan: "team", status: "active" } as never);
	vi.mocked(resolvePlanEntitlements).mockReturnValue(aiEntitlement() as never);
});

describe("isAiSurfaceEnabled", () => {
	it("is always enabled on self-host (no Stripe)", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		expect(await isAiSurfaceEnabled("org-1")).toBe(true);
	});

	it("reflects the plan entitlement when hosted", async () => {
		vi.mocked(resolvePlanEntitlements).mockReturnValue(aiEntitlement({ enabled: false }) as never);
		expect(await isAiSurfaceEnabled("org-1")).toBe(false);
	});
});

describe("assertAiAllowed", () => {
	it("bypasses with a zero charge on self-host", async () => {
		vi.mocked(isStripeConfigured).mockReturnValue(false);
		expect(await assertAiAllowed("org-1", "scan" as never)).toEqual({ source: "included", credits: 0 });
	});

	it("throws not_enabled when the plan has AI off", async () => {
		vi.mocked(resolvePlanEntitlements).mockReturnValue(aiEntitlement({ enabled: false }) as never);
		const err = await assertAiAllowed("org-1", "scan" as never).catch((e) => e);
		expect(err).toBeInstanceOf(AiBudgetError);
		expect(err.reason).toBe("not_enabled");
	});

	it("charges included credits when within both window and weekly caps", async () => {
		vi.mocked(sumCredits).mockResolvedValue(0); // both window + week used = 0
		expect(await assertAiAllowed("org-1", "scan" as never)).toEqual({ source: "included", credits: 5 });
	});

	it("falls back to purchased credits when the included window is exhausted", async () => {
		vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(30); // window full
		vi.mocked(purchasedBalance).mockResolvedValue(10); // >= cost 5
		expect(await assertAiAllowed("org-1", "scan" as never)).toEqual({ source: "purchased", credits: 5 });
	});

	it("throws window-exhausted (with a resetAt) when nothing is left", async () => {
		vi.mocked(sumCredits).mockResolvedValueOnce(30).mockResolvedValueOnce(30); // window full, week ok
		vi.mocked(purchasedBalance).mockResolvedValue(0);
		const err = await assertAiAllowed("org-1", "scan" as never).catch((e) => e);
		expect(err.reason).toBe("window");
		expect(err.resetAt).not.toBeNull();
	});

	it("throws weekly-exhausted when the weekly cap is the binding limit", async () => {
		vi.mocked(sumCredits).mockResolvedValueOnce(0).mockResolvedValueOnce(100); // week full
		vi.mocked(purchasedBalance).mockResolvedValue(0);
		const err = await assertAiAllowed("org-1", "scan" as never).catch((e) => e);
		expect(err.reason).toBe("weekly");
	});
});
