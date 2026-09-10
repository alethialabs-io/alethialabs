// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { effectiveBillingPeriodStart } from "@/lib/billing/period";

describe("effectiveBillingPeriodStart", () => {
	it("resets an open-ended grant monthly on its grant-day anchor", () => {
		const start = new Date("2026-01-12T09:30:00.000Z");
		const now = new Date("2026-08-31T12:00:00.000Z");
		expect(effectiveBillingPeriodStart(start, null, now).toISOString()).toBe(
			"2026-08-12T09:30:00.000Z",
		);
	});

	it("uses the previous month before this month's anchor", () => {
		const start = new Date("2026-01-20T09:30:00.000Z");
		const now = new Date("2026-08-10T12:00:00.000Z");
		expect(effectiveBillingPeriodStart(start, null, now).toISOString()).toBe(
			"2026-07-20T09:30:00.000Z",
		);
	});

	// In JANUARY the step back crosses a year boundary, and those two statements
	// (`month = 11; year -= 1;`) were the only ones in this module nothing executed. Left
	// unpinned they are reachable ONLY from a caller holding a real clock — `assertUsageAllowed`
	// passes `new Date()` — which makes whether they are covered a question about the month CI
	// happens to run in. That is the same class of defect as #3342 itself: a statement executed
	// on some runs and not others, moving a zero-slack coverage floor under unrelated PRs.
	it("steps back into the previous YEAR when the anchor has not come round in January", () => {
		const start = new Date("2026-01-20T09:30:00.000Z");
		const now = new Date("2027-01-10T12:00:00.000Z");
		expect(effectiveBillingPeriodStart(start, null, now).toISOString()).toBe(
			"2026-12-20T09:30:00.000Z",
		);
	});

	it("clamps a month-end anchor to the target month's final day", () => {
		const start = new Date("2026-01-31T09:30:00.000Z");
		const now = new Date("2026-02-28T12:00:00.000Z");
		expect(effectiveBillingPeriodStart(start, null, now).toISOString()).toBe(
			"2026-02-28T09:30:00.000Z",
		);
	});

	it("preserves Stripe's bounded billing period", () => {
		const start = new Date("2026-01-12T09:30:00.000Z");
		const end = new Date("2027-01-12T09:30:00.000Z");
		expect(effectiveBillingPeriodStart(start, end, new Date("2026-08-31T12:00:00Z"))).toBe(
			start,
		);
	});
});
