// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	AI_CREDIT_PACKS,
	creditPack,
	creditsFor,
	DEEP_REASONING_CREDITS,
	MESSAGE_CREDITS,
	SCAN_CREDITS,
} from "@/lib/billing/ai-credits";

describe("creditsFor", () => {
	it("charges a scan more than a message", () => {
		expect(creditsFor("scan")).toBe(SCAN_CREDITS);
		expect(creditsFor("agent")).toBe(MESSAGE_CREDITS);
		expect(SCAN_CREDITS).toBeGreaterThan(MESSAGE_CREDITS);
	});

	it("pins the flat costs: scan=20, message=1, deep-reasoning message=2", () => {
		expect(creditsFor("scan")).toBe(20);
		expect(creditsFor("agent")).toBe(1);
		expect(creditsFor("agent", { deepReasoning: true })).toBe(2);
		expect(DEEP_REASONING_CREDITS).toBe(2);
	});

	it("charges double for a deep-reasoning turn, but a scan stays flat", () => {
		expect(creditsFor("agent", { deepReasoning: false })).toBe(MESSAGE_CREDITS);
		expect(creditsFor("agent", { deepReasoning: true })).toBe(DEEP_REASONING_CREDITS);
		// Deep reasoning never changes the scan cost (heavy flat rate).
		expect(creditsFor("scan", { deepReasoning: true })).toBe(SCAN_CREDITS);
	});
});

describe("creditPack", () => {
	it("looks up a known pack", () => {
		expect(creditPack("s")).toEqual({ id: "s", credits: 100, amountCents: 2500 });
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

	it("offers larger packs at a better per-credit price", () => {
		const sorted = [...AI_CREDIT_PACKS].sort((a, b) => a.credits - b.credits);
		const rate = (p: (typeof AI_CREDIT_PACKS)[number]) => p.amountCents / p.credits;
		for (let i = 1; i < sorted.length; i++) {
			expect(rate(sorted[i])).toBeLessThanOrEqual(rate(sorted[i - 1]));
		}
	});
});
