// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	FALLBACK_HOURLY_EUR,
	computeUtilizationPct,
	estimatePoolCostEur,
	hourlyRateEur,
} from "@/lib/fleet/costs";
import { describe, expect, it } from "vitest";

describe("fleet cost model", () => {
	it("prices a known server type by hours × rate", () => {
		const rate = hourlyRateEur("cax21");
		expect(estimatePoolCostEur(100, "cax21")).toBeCloseTo(100 * rate, 6);
	});

	it("falls back to the default rate for an unknown server type", () => {
		expect(hourlyRateEur("nonsense")).toBe(FALLBACK_HOURLY_EUR);
		expect(estimatePoolCostEur(10, "nonsense")).toBeCloseTo(10 * FALLBACK_HOURLY_EUR, 6);
	});

	it("is zero for zero (or negative) provisioned hours", () => {
		expect(estimatePoolCostEur(0, "cax21")).toBe(0);
		expect(estimatePoolCostEur(-5, "cax21")).toBe(0);
	});
});

describe("fleet utilization", () => {
	it("is busy-minutes over offered capacity-minutes", () => {
		// 2 provisioned hours × 60 × 1 slot = 120 capacity-min; 60 busy → 50%.
		expect(computeUtilizationPct(60, 2, 1)).toBeCloseTo(50, 6);
	});

	it("accounts for concurrent slots in the denominator", () => {
		// 1h × 60 × 2 slots = 120 capacity-min; 60 busy → 50% (vs 100% at 1 slot).
		expect(computeUtilizationPct(60, 1, 2)).toBeCloseTo(50, 6);
	});

	it("is 0 when nothing was provisioned", () => {
		expect(computeUtilizationPct(30, 0, 1)).toBe(0);
	});

	it("clamps to [0,100] when busy exceeds the window (clock skew / in-flight)", () => {
		expect(computeUtilizationPct(1000, 1, 1)).toBe(100);
		expect(computeUtilizationPct(-10, 1, 1)).toBe(0);
	});
});
