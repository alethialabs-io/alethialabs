// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The plan catalog lives in @repo/plan-catalog (no test runner of its own); exercise it
// from the console suite, the same way @repo/ui/range is tested here.

import { describe, expect, it } from "vitest";
import { PAID_PLANS, PLAN_CATALOG, planMeta, planUnitAmountCents } from "../src/index";

describe("planMeta", () => {
	it("resolves each known plan to its display entry", () => {
		expect(planMeta("community").name).toBe("Hobby");
		expect(planMeta("team").name).toBe("Pro");
		expect(planMeta("enterprise").name).toBe("Enterprise");
	});

	it("falls back to community for an unknown id", () => {
		// @ts-expect-error — exercising the runtime fallback path
		expect(planMeta("mystery").id).toBe("community");
	});
});

describe("PLAN_CATALOG invariants", () => {
	it("has unique plan ids", () => {
		const ids = PLAN_CATALOG.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("marks Pro as per-seat with an included usage credit", () => {
		const team = planMeta("team");
		expect(team.perSeat).toBe(true);
		expect(team.priceMonthlyUsd).toBeGreaterThan(0);
		expect(team.includedCreditUsd).toBeGreaterThan(0);
	});

	it("prices Pro in both USD and EUR", () => {
		const team = planMeta("team");
		expect(team.priceMonthlyEur).toBeGreaterThan(0);
		// EUR is FX-adjusted, not parity.
		expect(team.priceMonthlyEur).not.toBe(team.priceMonthlyUsd);
	});
});

describe("planUnitAmountCents", () => {
	it("returns the per-currency amount in cents (default USD)", () => {
		expect(planUnitAmountCents("team")).toBe((planMeta("team").priceMonthlyUsd ?? 0) * 100);
		expect(planUnitAmountCents("team", "usd")).toBe(planUnitAmountCents("team"));
		expect(planUnitAmountCents("team", "eur")).toBe((planMeta("team").priceMonthlyEur ?? 0) * 100);
	});

	it("throws for a plan without a numeric price (Enterprise)", () => {
		expect(() => planUnitAmountCents("enterprise")).toThrow();
		expect(() => planUnitAmountCents("enterprise", "eur")).toThrow();
	});

	it("treats community as the only free tier", () => {
		expect(planMeta("community").paid).toBe(false);
		expect(PLAN_CATALOG.filter((p) => !p.paid)).toHaveLength(1);
	});
});

describe("PAID_PLANS", () => {
	it("is exactly the paid tiers (excludes community)", () => {
		expect(PAID_PLANS.every((p) => p.paid)).toBe(true);
		expect(PAID_PLANS.map((p) => p.id)).not.toContain("community");
	});
});
