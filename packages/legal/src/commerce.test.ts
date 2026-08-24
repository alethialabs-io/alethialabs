// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	CONSUMER_ADR,
	CONSUMER_PAYMENT_OBLIGATION_LABEL,
	PAID_MARKETS,
	orderButtonLabel,
	paidMarketEnabled,
	paidMarketEvidence,
	withdrawalOutcome,
} from "./commerce";
import { LEGAL_ENTITY } from "./entity";

describe("paid markets", () => {
	// The gate is only a gate while it is shut. This is not "assert the current value" — it is the
	// invariant that opening a cell requires the evidence, and the evidence does not exist yet:
	// LEGAL_ENTITY.vatRegistered is false, so there is no registration under which to charge VAT.
	it("is closed, and stays closed while the company is not VAT-registered", () => {
		if (!LEGAL_ENTITY.vatRegistered) {
			expect(PAID_MARKETS).toHaveLength(0);
		}
	});

	it("refuses everything while no cell is open", () => {
		expect(paidMarketEnabled("BG", "consumer")).toBe(false);
		expect(paidMarketEnabled("DE", "organization")).toBe(false);
	});

	// Fail-closed on the inputs too, not only on the list: a missing country must never fall back to
	// the seller's own jurisdiction, which is the plausible-looking default that would enable exactly
	// the market we are least ready to sell into.
	it("refuses missing, malformed and unknown inputs rather than defaulting", () => {
		expect(paidMarketEnabled(null, "consumer")).toBe(false);
		expect(paidMarketEnabled("", "consumer")).toBe(false);
		expect(paidMarketEnabled("BG", null)).toBe(false);
		expect(paidMarketEnabled("BGR", "consumer")).toBe(false);
		expect(paidMarketEnabled("b", "consumer")).toBe(false);
	});

	// Every cell carries an audit trail, so a cell cannot be opened by editing an array.
	it("requires evidence and an upper-case ISO-3166 alpha-2 country on every cell", () => {
		for (const cell of PAID_MARKETS) {
			expect(cell.country).toMatch(/^[A-Z]{2}$/);
			expect(cell.evidence.trim().length).toBeGreaterThan(20);
			expect(paidMarketEnabled(cell.country, cell.capacity)).toBe(true);
			expect(paidMarketEvidence(cell.country, cell.capacity)).toBe(cell.evidence);
		}
	});

	it("matches a country case-insensitively once a cell is open", () => {
		// Exercised against a synthetic cell so the rule keeps its teeth on an empty list.
		const open = [{ country: "BG", capacity: "consumer" as const, evidence: "x" }];
		const enabled = (c: string) =>
			open.some((k) => k.country === c.trim().toUpperCase() && k.capacity === "consumer");
		expect(enabled("bg")).toBe(true);
		expect(enabled(" BG ")).toBe(true);
	});
});

describe("statutory withdrawal accounting (CRD art. 14(3))", () => {
	const base = {
		paidMinorUnits: 12_000,
		periodDays: 30,
		daysSupplied: 10,
		performanceStart: "immediate" as const,
		acknowledgedProportionalCharge: true,
	};

	// Nothing was supplied, so nothing may be kept. A "processing fee" here is simply unlawful.
	it("refunds everything when performance was deferred, even if days elapsed", () => {
		const out = withdrawalOutcome({
			...base,
			performanceStart: "deferred",
			daysSupplied: 29,
		});
		expect(out.refundMinorUnits).toBe(12_000);
		expect(out.retainedMinorUnits).toBe(0);
	});

	// THE sanction, and the reason the purchase flow must capture BOTH halves. Service really was
	// supplied here — and the trader may still keep nothing, because the acknowledgement was never
	// obtained. Getting this wrong is a silent overcharge of every withdrawing consumer.
	it("refunds everything when immediate performance was never acknowledged", () => {
		const out = withdrawalOutcome({
			...base,
			acknowledgedProportionalCharge: false,
		});
		expect(out.retainedMinorUnits).toBe(0);
		expect(out.refundMinorUnits).toBe(12_000);
		expect(out.basis).toMatch(/not acknowledged/i);
	});

	it("retains the supplied proportion when immediate performance was requested and acknowledged", () => {
		const out = withdrawalOutcome(base);
		expect(out.retainedMinorUnits).toBe(4_000); // 10/30 of 12000
		expect(out.refundMinorUnits).toBe(8_000);
	});

	// Rounding is a policy decision, and it goes to the consumer.
	it("floors the retained amount, so a fractional minor unit becomes refund", () => {
		const out = withdrawalOutcome({ ...base, paidMinorUnits: 1_000, periodDays: 30, daysSupplied: 1 });
		expect(out.retainedMinorUnits).toBe(33); // 33.33… floored
		expect(out.refundMinorUnits).toBe(967);
	});

	// The two halves must always reconcile — a split that loses or invents a minor unit would show up
	// as an unexplained difference between what Stripe refunded and what the record says.
	it("always splits the exact amount paid", () => {
		for (const days of [0, 1, 7, 15, 29, 30, 31, 400]) {
			for (const paid of [0, 1, 99, 12_000, 999_999]) {
				const out = withdrawalOutcome({ ...base, paidMinorUnits: paid, daysSupplied: days });
				expect(out.retainedMinorUnits + out.refundMinorUnits).toBe(paid);
				expect(out.retainedMinorUnits).toBeGreaterThanOrEqual(0);
				expect(out.refundMinorUnits).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("never retains more than the price when more days are supplied than the period holds", () => {
		const out = withdrawalOutcome({ ...base, daysSupplied: 900 });
		expect(out.retainedMinorUnits).toBe(12_000);
		expect(out.refundMinorUnits).toBe(0);
	});

	it("refunds everything rather than dividing by zero on a period with no length", () => {
		const out = withdrawalOutcome({ ...base, periodDays: 0 });
		expect(out.refundMinorUnits).toBe(12_000);
	});

	it("treats a negative amount or negative days as zero rather than inverting the split", () => {
		expect(withdrawalOutcome({ ...base, paidMinorUnits: -500 }).refundMinorUnits).toBe(0);
		expect(withdrawalOutcome({ ...base, daysSupplied: -5 }).retainedMinorUnits).toBe(0);
	});
});

describe("contract formation", () => {
	// CRD art. 8(2): a vaguer label does not bind the consumer at all. Pinned so a copy edit that
	// softens it is a failing test rather than an unenforceable order.
	it("labels a consumer order with an unambiguous payment obligation", () => {
		expect(orderButtonLabel("consumer")).toBe(CONSUMER_PAYMENT_OBLIGATION_LABEL);
		expect(CONSUMER_PAYMENT_OBLIGATION_LABEL.toLowerCase()).toContain("obligation to pay");
	});

	it("does not put the consumer formulation on an organization order", () => {
		expect(orderButtonLabel("organization")).not.toBe(CONSUMER_PAYMENT_OBLIGATION_LABEL);
		expect(orderButtonLabel("organization").length).toBeGreaterThan(0);
	});
});

describe("consumer dispute resolution", () => {
	it("names a reachable body for every entry", () => {
		expect(CONSUMER_ADR.length).toBeGreaterThan(0);
		for (const body of CONSUMER_ADR) {
			expect(body.url).toMatch(/^https:\/\//);
			expect(body.name.length).toBeGreaterThan(0);
			expect(body.localName.length).toBeGreaterThan(0);
			expect(body.role.length).toBeGreaterThan(0);
		}
	});

	// Regulation (EU) 524/2013 was repealed and the ODR platform ceased on 20 July 2025. Linking it
	// points consumers at a dead service AND states an obligation that no longer exists — and it is
	// still what most templates say, which is exactly why this is a test and not a comment.
	it("does not link the repealed EU ODR platform", () => {
		for (const body of CONSUMER_ADR) {
			expect(body.url).not.toMatch(/ec\.europa\.eu\/consumers\/odr/i);
			expect(body.url).not.toMatch(/\bodr\b/i);
		}
	});
});
