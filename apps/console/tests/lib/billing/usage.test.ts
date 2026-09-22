// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	computeUsage,
	OVERAGE_RATE_PER_MIN,
	USAGE_ALERT_THRESHOLD,
} from "@/lib/billing/usage";
import { describe, expect, it } from "vitest";
import { money } from "@repo/format";

describe("computeUsage", () => {
	it("is all headroom when well within the allowance", () => {
		const u = computeUsage(100, 500);
		expect(u.overageMinutes).toBe(0);
		expect(u.overageCost).toEqual(money(0, "usd"));
		expect(u.pct).toBeCloseTo(0.2);
		expect(u.approaching).toBe(false);
		expect(u.overLimit).toBe(false);
	});

	it("flags approaching at the alert threshold", () => {
		const u = computeUsage(USAGE_ALERT_THRESHOLD * 500, 500);
		expect(u.approaching).toBe(true);
		expect(u.overLimit).toBe(false);
	});

	it("computes overage minutes and cost beyond the allowance", () => {
		const u = computeUsage(800, 500); // 300 over
		expect(u.overageMinutes).toBe(300);
		// MINOR units with the currency attached (#4176 part b). Both halves are asserted as
		// LITERALS as well as against the rate: an identity against `OVERAGE_RATE_PER_MIN` alone
		// would still pass if the unit silently moved back to dollars.
		expect(u.overageCost).toEqual(money(360, "usd")); // $3.60
		expect(u.overageCost.minor).toBe(Math.round(300 * OVERAGE_RATE_PER_MIN * 100));
		expect(u.overLimit).toBe(true);
		expect(u.pct).toBeCloseTo(1.6);
	});

	it("rounds the cost estimate to whole minor units", () => {
		const u = computeUsage(501, 500); // 1 min over → $0.012 → $0.01
		expect(u.overageCost).toEqual(money(1, "usd"));
	});

	it("clamps negatives and handles a zero allowance", () => {
		expect(computeUsage(-5, 500).usedMinutes).toBe(0);
		const z = computeUsage(10, 0);
		expect(z.overageMinutes).toBe(10);
		expect(z.pct).toBe(Number.POSITIVE_INFINITY);
	});
});
