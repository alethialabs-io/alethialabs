// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Usage card's percentage, which the ring and the caption now share (#2876). The two used to
// compute it separately — one clamped, one not — so these lock the properties that made them
// disagree: a sub-1% usage is not 0, an overage is not flattened to 100, and both renderers get
// the same string for the same pair.

import { describe, expect, it } from "vitest";
import {
	NEAR_LIMIT_RATIO,
	formatUsagePercent,
	usageRatio,
} from "@/components/overview/usage-percent";

describe("usageRatio", () => {
	it("is the plain fraction consumed", () => {
		expect(usageRatio(100, 200)).toBe(0.5);
		expect(usageRatio(0.943, 200)).toBeCloseTo(0.004715, 6);
	});

	it("does NOT clamp an overage — the ring clamps its own arc, the number stays true", () => {
		expect(usageRatio(250, 200)).toBe(1.25);
	});

	it("is 0 for an uncapped or nonsensical allowance rather than Infinity/NaN", () => {
		expect(usageRatio(50, 0)).toBe(0);
		expect(usageRatio(50, -1)).toBe(0);
		expect(usageRatio(Number.NaN, 200)).toBe(0);
		expect(usageRatio(50, Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("clamps negative usage to 0", () => {
		expect(usageRatio(-10, 200)).toBe(0);
	});
});

describe("formatUsagePercent", () => {
	it("distinguishes an unused allowance from a barely-used one", () => {
		// The reported bug's exact pair: 0.943 of 200 minutes is 0.47%, which used to read
		// "0% used" beside a readout saying something HAD run.
		expect(formatUsagePercent(0, 200)).toBe("0");
		expect(formatUsagePercent(0.943, 200)).toBe("<1");
	});

	it("rounds to whole percent in the ordinary range", () => {
		// The boundary: 1.99 min of 200 is 0.995% and still "<1"; 2 min is exactly 1%.
		expect(formatUsagePercent(1.99, 200)).toBe("<1");
		expect(formatUsagePercent(2, 200)).toBe("1");
		expect(formatUsagePercent(100, 200)).toBe("50");
		expect(formatUsagePercent(169.2, 200)).toBe("85");
		expect(formatUsagePercent(200, 200)).toBe("100");
	});

	it("reports an overage instead of flattening it to 100", () => {
		expect(formatUsagePercent(250, 200)).toBe("125");
	});

	it("is 0 when there is no allowance to be a percentage of", () => {
		expect(formatUsagePercent(50, 0)).toBe("0");
	});

	it("agrees with the near-limit threshold the card inks on", () => {
		expect(usageRatio(170, 200)).toBeGreaterThanOrEqual(NEAR_LIMIT_RATIO);
		expect(usageRatio(169, 200)).toBeLessThan(NEAR_LIMIT_RATIO);
	});
});
