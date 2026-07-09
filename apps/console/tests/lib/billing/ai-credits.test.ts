// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	AI_CREDIT_PACKS,
	CREDIT_UNIT_MICROS,
	costToCredits,
	creditPack,
	creditsFor,
	SCAN_CREDITS,
} from "@/lib/billing/ai-credits";

describe("costToCredits", () => {
	it("converts real cost (USD micros) to cost-weighted credits, rounding up", () => {
		// 1 credit = $0.001 = 1000 micros.
		expect(CREDIT_UNIT_MICROS).toBe(1000);
		// A ~$0.084 Sonnet turn ≈ 84 credits; a ~$0.117 Opus turn ≈ 117.
		expect(costToCredits(84_000)).toBe(84);
		expect(costToCredits(117_000)).toBe(117);
		// A zero-cost row is zero credits.
		expect(costToCredits(0)).toBe(0);
	});

	it("rounds a fractional-unit cost up (never undercharges)", () => {
		expect(costToCredits(1)).toBe(1); // $0.000001 → 1 credit
		expect(costToCredits(1500)).toBe(2); // 1.5 units → 2 credits
	});
});

describe("creditsFor", () => {
	it("charges the fixed nominal cost for a scan and nothing for metered turns", () => {
		// Scan is the only fixed-cost kind; its real cost is on the runner job.
		expect(creditsFor("scan")).toBe(SCAN_CREDITS);
		expect(SCAN_CREDITS).toBe(200);
		// Metered turns settle their real cost — no fixed per-message charge.
		expect(creditsFor("agent")).toBe(0);
		expect(creditsFor("support")).toBe(0);
	});
});

describe("creditPack", () => {
	it("looks up a known pack", () => {
		expect(creditPack("s")).toEqual({ id: "s", credits: 5_000, amountCents: 1_900 });
	});

	it("returns undefined for an unknown id", () => {
		expect(creditPack("nope")).toBeUndefined();
	});
});

describe("AI_CREDIT_PACKS invariants", () => {
	it("has unique ids and strictly positive credits/amounts", () => {
		const ids = AI_CREDIT_PACKS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const p of AI_CREDIT_PACKS) {
			expect(p.credits).toBeGreaterThan(0);
			expect(p.amountCents).toBeGreaterThan(0);
		}
	});

	it("prices every pack comfortably above the $0.001 cost-of-serve", () => {
		// $/credit must exceed the cost-of-serve unit ($0.001) so packs carry margin.
		for (const p of AI_CREDIT_PACKS) {
			const usdPerCredit = p.amountCents / 100 / p.credits;
			expect(usdPerCredit).toBeGreaterThan(0.001);
		}
	});

	it("offers larger packs at a better per-credit price", () => {
		const sorted = [...AI_CREDIT_PACKS].sort((a, b) => a.credits - b.credits);
		const rate = (p: (typeof AI_CREDIT_PACKS)[number]) => p.amountCents / p.credits;
		for (let i = 1; i < sorted.length; i++) {
			expect(rate(sorted[i])).toBeLessThanOrEqual(rate(sorted[i - 1]));
		}
	});
});
