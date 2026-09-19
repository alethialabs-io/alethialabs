// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	FALLBACK_HOURLY_EUR,
	MEASURED_ON,
	SERVER_PRICE_EUR,
	cappedMonthlyCostEur,
	computeUtilizationPct,
	estimatePoolCostEur,
	hourlyRateEur,
} from "@/lib/fleet/costs";
import { hcloudConfigFromEnv } from "@/lib/fleet/hcloud";
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

	// The hole #4412 was really about. The rates being stale was the symptom; nothing noticing
	// was the defect. A unit test cannot reach Hetzner, so it cannot check that a PRICE is
	// current — but it can check the two things that made a stale price expensive.
	it("prices every server type the fleet can actually place", () => {
		// Read from the REAL resolver rather than re-typed here — a hand-copied list is exactly how
		// this drifts back. `hcloudConfigFromEnv` makes no network call; it only needs these two
		// variables present to return, and `serverTypes` is the placement preference order.
		const prev = { t: process.env.HCLOUD_TOKEN, o: process.env.ALETHIA_WEB_ORIGIN };
		process.env.HCLOUD_TOKEN = "test-token-no-call-is-made";
		process.env.ALETHIA_WEB_ORIGIN = "https://example.invalid";
		try {
			const { serverTypes } = hcloudConfigFromEnv();
			expect(serverTypes.length).toBeGreaterThan(0); // vacuity guard
			for (const type of serverTypes) {
				expect(SERVER_PRICE_EUR[type], `${type} is placeable but unpriced`).toBeDefined();
			}
		} finally {
			if (prev.t === undefined) delete process.env.HCLOUD_TOKEN;
			else process.env.HCLOUD_TOKEN = prev.t;
			if (prev.o === undefined) delete process.env.ALETHIA_WEB_ORIGIN;
			else process.env.ALETHIA_WEB_ORIGIN = prev.o;
		}
	});

	it("never derives hourly from the monthly cap — Hetzner bills the other way round", () => {
		// `hourly × 730` must EXCEED the cap, or the cap can never bind and the old
		// "hourly ≈ monthly / 730" model has crept back in.
		for (const [type, p] of Object.entries(SERVER_PRICE_EUR)) {
			expect(p.hourly * 730, `${type}: cap can never bind`).toBeGreaterThan(p.monthlyCap);
		}
	});

	it("carries the date its rates were measured", () => {
		expect(MEASURED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("fleet cost model — the monthly cap (one server)", () => {
	it("bills hourly below the cap", () => {
		const p = SERVER_PRICE_EUR.cax21;
		expect(cappedMonthlyCostEur(100, "cax21")).toBeCloseTo(100 * p.hourly, 6);
	});

	it("stops at the cap for a server held a full month", () => {
		const p = SERVER_PRICE_EUR.cax21;
		expect(cappedMonthlyCostEur(730, "cax21")).toBeCloseTo(p.monthlyCap, 6);
		// And that is strictly cheaper than the uncapped estimate — the point of the whole change.
		expect(cappedMonthlyCostEur(730, "cax21")).toBeLessThan(estimatePoolCostEur(730, "cax21"));
	});

	it("charges one cap per whole month, then hourly for the remainder", () => {
		const p = SERVER_PRICE_EUR.cax21;
		expect(cappedMonthlyCostEur(730 + 10, "cax21")).toBeCloseTo(p.monthlyCap + 10 * p.hourly, 6);
		expect(cappedMonthlyCostEur(1460, "cax21")).toBeCloseTo(2 * p.monthlyCap, 6);
	});

	it("is zero for zero or negative hours, and falls back for an unknown type", () => {
		expect(cappedMonthlyCostEur(0, "cax21")).toBe(0);
		expect(cappedMonthlyCostEur(-1, "cax21")).toBe(0);
		expect(cappedMonthlyCostEur(100, "nonsense")).toBeCloseTo(100 * FALLBACK_HOURLY_EUR, 6);
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
